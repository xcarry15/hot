import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  EVENT_CLUSTER_MAX_CANDIDATES,
  EVENT_CLUSTER_MAX_RETRIES,
  EVENT_CLUSTER_AMBIGUOUS_CONTENT_OVERLAP,
  EVENT_CLUSTER_AMBIGUOUS_TITLE_OVERLAP,
  EVENT_CLUSTER_RULE_VERSION,
  EVENT_CLUSTER_STRONG_CONTENT_JACCARD,
  EVENT_CLUSTER_STRONG_CONTENT_OVERLAP,
  EVENT_CLUSTER_STRONG_TITLE_DAYS,
  EVENT_CLUSTER_STRONG_TITLE_OVERLAP,
  EVENT_CLUSTER_WINDOW_DAYS,
  buildRuleEventKey,
  contentShingleSimilarity,
  hasLiteralContentOverlap,
  hasEventPhaseConflict,
  isMultiTopicTitle,
  normalizeEventText,
  overlapCoefficient,
  sharedEventAnchors,
} from '@/contracts/event-clustering';
import { createChatCompletion } from '@/lib/ai-client';
import { extractJsonObject } from '@/lib/ai-helpers';
import { db } from '@/lib/db';

const aiDecisionSchema = z.object({
  same_event: z.boolean(),
  confidence: z.number().int().min(0).max(100),
  event_key: z.string().max(160).optional().default(''),
  reason: z.string().max(300),
});

type ClusterClient = Pick<Prisma.TransactionClient, 'article' | 'event' | 'eventClusterAudit'>;
const CONTENT_RECALL_CANDIDATES = 12;

type Candidate = {
  id: string;
  representativeArticleId: string | null;
  articles: Array<{
    id: string;
    title: string;
    cleanContent: string;
    contentHash: string;
    eventKey: string;
    publishedAt: Date | null;
    createdAt: Date;
  }>;
};

export interface AiCandidateAudit {
  candidateEventId: string;
  ruleEvidence: {
    exactTitle: boolean;
    fingerprint: boolean;
    eventKeyMatch: boolean;
    titleOverlap: number;
    contentOverlap: number;
    contentJaccard: number;
    daysApart: number;
    phaseConflict: boolean;
    multiTopic: boolean;
    sharedAnchors: string[];
  };
  aiDecision: { sameEvent: boolean; confidence: number; reason: string; eventKey: string };
}

export function buildAiClusterAuditEvidence(candidates: AiCandidateAudit[], selectedCandidateEventId: string | null) {
  return { selectedCandidateEventId, candidates: [...candidates] };
}

function articleDate(article: { publishedAt: Date | null; createdAt: Date }): Date {
  return article.publishedAt ?? article.createdAt;
}

function candidateEvidence(
  article: { title: string; cleanContent: string; contentHash: string; eventKey: string; publishedAt: Date | null; createdAt: Date },
  candidate: Candidate,
  includeContent = true,
) {
  const normalizedTitle = normalizeEventText(article.title);
  let exactTitle = false;
  let fingerprint = false;
  let eventKeyMatch = false;
  let titleOverlap = 0;
  let contentOverlap = 0;
  let contentJaccard = 0;
  let daysApart = Number.POSITIVE_INFINITY;
  let phaseConflict = false;
  let multiTopic = isMultiTopicTitle(article.title);
  let sharedAnchors: string[] = [];
  for (const member of candidate.articles) {
    exactTitle ||= normalizedTitle.length > 0 && normalizedTitle === normalizeEventText(member.title);
    fingerprint ||= article.contentHash.length > 0 && article.contentHash === member.contentHash;
    eventKeyMatch ||= article.eventKey.length > 0 && article.eventKey === member.eventKey;
    titleOverlap = Math.max(titleOverlap, overlapCoefficient(article.title, member.title));
    if (includeContent) {
      const content = contentShingleSimilarity(article.cleanContent, member.cleanContent);
      contentOverlap = Math.max(contentOverlap, content.overlap);
      contentJaccard = Math.max(contentJaccard, content.jaccard);
    }
    daysApart = Math.min(daysApart, Math.abs(articleDate(article).getTime() - articleDate(member).getTime()) / 86_400_000);
    phaseConflict ||= hasEventPhaseConflict(article.title, member.title);
    multiTopic ||= isMultiTopicTitle(member.title);
    const anchors = sharedEventAnchors(article.title, member.title);
    if (anchors.length > sharedAnchors.length) sharedAnchors = anchors;
  }
  return {
    exactTitle,
    fingerprint,
    eventKeyMatch,
    titleOverlap,
    contentOverlap,
    contentJaccard,
    daysApart: Number.isFinite(daysApart) ? daysApart : EVENT_CLUSTER_WINDOW_DAYS,
    phaseConflict,
    multiTopic,
    sharedAnchors,
  };
}

function hasCandidateContentHint(article: { cleanContent: string }, candidate: Candidate): boolean {
  return candidate.articles.some((member) => hasLiteralContentOverlap(article.cleanContent, member.cleanContent));
}

async function createEventForArticle(
  client: ClusterClient,
  article: { id: string; title: string; publishedAt: Date | null; createdAt: Date; eventKey: string },
  input: { action: 'create' | 'fallback_create'; decisionSource: 'rule' | 'ai'; confidence?: number; evidence: object; needsReview?: boolean; candidateEventId?: string },
): Promise<string> {
  const seenAt = articleDate(article);
  const event = await client.event.create({
    data: {
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      articleCount: 1,
      // 聚类发生在 AI 之前；代表文章必须等待 AI 完成后由 event-service 统一选择。
      representativeArticleId: null,
    },
    select: { id: true },
  });
  await client.article.update({
    where: { id: article.id },
    data: {
      eventId: event.id,
      clusterStatus: input.needsReview ? 'needs_review' : 'clustered',
      clusteredAt: new Date(),
      clusterError: null,
      clusterRetryCount: 0,
      nextClusterRetryAt: null,
    },
  });
  await client.eventClusterAudit.create({
    data: {
      articleId: article.id,
      assignedEventId: event.id,
      candidateEventId: input.candidateEventId,
      actor: 'system',
      action: input.action,
      decisionSource: input.decisionSource,
      confidence: input.confidence,
      evidence: JSON.stringify({ ruleVersion: EVENT_CLUSTER_RULE_VERSION, ...input.evidence }),
    },
  });
  return event.id;
}

async function attachArticle(
  client: ClusterClient,
  article: { id: string; publishedAt: Date | null; createdAt: Date },
  candidate: Candidate,
  decisionSource: 'exact' | 'rule' | 'ai',
  confidence: number,
  evidence: object,
): Promise<string> {
  const seenAt = articleDate(article);
  const currentEvent = await client.event.findUnique({
    where: { id: candidate.id },
    select: { firstSeenAt: true, lastSeenAt: true },
  });
  if (!currentEvent) throw new Error('候选事件不存在');
  await client.article.update({
    where: { id: article.id },
    data: {
      eventId: candidate.id,
      clusterStatus: 'clustered',
      clusteredAt: new Date(),
      clusterError: null,
      clusterRetryCount: 0,
      nextClusterRetryAt: null,
    },
  });
  await client.event.update({
    where: { id: candidate.id },
    data: {
      articleCount: { increment: 1 },
      firstSeenAt: seenAt < currentEvent.firstSeenAt ? seenAt : currentEvent.firstSeenAt,
      lastSeenAt: seenAt > currentEvent.lastSeenAt ? seenAt : currentEvent.lastSeenAt,
    },
  });
  await client.eventClusterAudit.create({
    data: {
      articleId: article.id,
      assignedEventId: candidate.id,
      candidateEventId: candidate.id,
      actor: 'system',
      action: 'attach',
      decisionSource,
      confidence,
      evidence: JSON.stringify({ ruleVersion: EVENT_CLUSTER_RULE_VERSION, ...evidence }),
    },
  });
  return candidate.id;
}

async function askAiSameEvent(
  article: { title: string; cleanContent: string },
  candidate: Candidate,
  signal?: AbortSignal,
) {
  const candidateArticles = candidate.articles.slice(0, 3).map((item) => `- 标题：${item.title}\n  正文：${item.cleanContent.slice(0, 500)}`).join('\n');
  const prompt = `判断是否是同一个具体新闻事件。
同一事件必须同时满足：核心主体相同、具体动作/结果相同、时间阶段一致。
以下均不算同一事件：只有品牌/地点/奖项/话题相同；预告与事后结果；聚合快讯仅有一个子项重合。
证据不足时返回 false。

新文章：${article.title}
正文：${article.cleanContent.slice(0, 900)}

候选报道：
${candidateArticles}

只返回 JSON：{"same_event":false,"confidence":0,"event_key":"核心主体|具体动作|具体事项","reason":"不超过50字"}`;
  const result = await createChatCompletion([
    { role: 'system', content: '你是保守的新闻事件聚类器，只根据给定文本判断，证据不足时分开。' },
    { role: 'user', content: prompt },
  ], { temperature: 0, maxTokens: 300, signal });
  return aiDecisionSchema.parse(extractJsonObject(result.content));
}

async function generateEventKey(article: { title: string; cleanContent: string }, signal?: AbortSignal): Promise<string> {
  try {
    const result = await createChatCompletion([
      { role: 'system', content: '你是新闻事件键提取器，不推测未出现的事实。' },
      { role: 'user', content: `提取“核心主体|具体动作|具体事项”，使其可用于区分具体新闻事件。
不使用“战略升级、进一步布局、行业动态”等泛词。无法确定则返回空字符串。
标题：${article.title}
正文：${article.cleanContent.slice(0, 600)}
只返回 JSON：{"event_key":""}` },
    ], { temperature: 0, maxTokens: 300, signal });
    return aiDecisionSchema.pick({ event_key: true }).parse(extractJsonObject(result.content)).event_key.trim();
  } catch (error) {
    console.warn('[event-clustering] eventKey AI fallback:', error);
    return '';
  }
}

export async function clusterArticle(articleId: string, signal?: AbortSignal): Promise<{ eventId: string; action: string }> {
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      title: true,
      cleanContent: true,
      contentHash: true,
      eventKey: true,
      publishedAt: true,
      createdAt: true,
      clusterStatus: true,
    },
  });
  if (!article) throw new Error('文章不存在');
  if (article.clusterStatus === 'clustered' || article.clusterStatus === 'needs_review') {
    const current = await db.article.findUnique({ where: { id: article.id }, select: { eventId: true } });
    if (current?.eventId) return { eventId: current.eventId, action: 'existing' };
  }

  const multiTopic = isMultiTopicTitle(article.title);
  const generatedKey = article.eventKey || (multiTopic
    ? buildRuleEventKey(article.title)
    : await generateEventKey(article, signal));
  const eventKey = generatedKey || buildRuleEventKey(article.title);
  if (eventKey !== article.eventKey) await db.article.update({ where: { id: article.id }, data: { eventKey } });
  if (multiTopic) {
    const eventId = await db.$transaction((tx) => createEventForArticle(tx, { ...article, eventKey }, {
      action: 'fallback_create',
      decisionSource: 'rule',
      confidence: 50,
      evidence: {
        eventKey,
        multiTopic: true,
        reason: '标题包含多个独立主体与动作，不能自动归入单一 Event',
        ...buildAiClusterAuditEvidence([], null),
      },
      needsReview: true,
    }));
    return { eventId, action: 'fallback_create' };
  }
  const referenceAt = articleDate(article);
  const windowMs = EVENT_CLUSTER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const windowStart = new Date(referenceAt.getTime() - windowMs);
  const windowEnd = new Date(referenceAt.getTime() + windowMs);
  const candidates = await db.event.findMany({
    where: {
      status: 'active',
      firstSeenAt: { lte: windowEnd },
      lastSeenAt: { gte: windowStart },
      articles: { some: { clusterStatus: 'clustered' } },
    },
    select: {
      id: true,
      representativeArticleId: true,
      articles: {
        where: { clusterStatus: 'clustered' },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, title: true, cleanContent: true, contentHash: true, eventKey: true, publishedAt: true, createdAt: true },
      },
    },
    orderBy: { lastSeenAt: 'desc' },
  });
  const recalled = candidates
    .map((candidate) => ({
      candidate,
      evidence: candidateEvidence({ ...article, eventKey }, candidate, false),
      contentHint: hasCandidateContentHint(article, candidate),
    }))
    .sort((left, right) => {
      const score = (value: typeof left.evidence) => Number(value.fingerprint) * 5
        + Number(value.exactTitle) * 4
        + Number(value.eventKeyMatch) * 1.5
        + value.titleOverlap * 2
        + Math.min(value.sharedAnchors.length, 3)
        - Number(value.phaseConflict) * 3
        - Number(value.multiTopic) * 1.5
        - Math.min(value.daysApart, EVENT_CLUSTER_WINDOW_DAYS) / EVENT_CLUSTER_WINDOW_DAYS;
      return Number(right.contentHint) * 4 + score(right.evidence)
        - (Number(left.contentHint) * 4 + score(left.evidence));
    })
    .slice(0, CONTENT_RECALL_CANDIDATES);
  const ranked = recalled
    .map(({ candidate }) => ({ candidate, evidence: candidateEvidence({ ...article, eventKey }, candidate) }))
    .sort((left, right) => {
      const score = (value: typeof left.evidence) => Number(value.fingerprint) * 5
        + Number(value.exactTitle) * 4
        + Number(value.eventKeyMatch) * 1.5
        + value.contentOverlap * 3
        + value.contentJaccard * 2
        + value.titleOverlap
        - Number(value.phaseConflict) * 3
        - Number(value.multiTopic) * 1.5;
      return score(right.evidence) - score(left.evidence);
    })
    .slice(0, EVENT_CLUSTER_MAX_CANDIDATES);

  const exact = ranked.find(({ evidence }) => evidence.fingerprint || (evidence.exactTitle && !evidence.phaseConflict));
  if (exact) {
    const eventId = await db.$transaction((tx) => attachArticle(tx, article, exact.candidate, 'exact', 100, exact.evidence));
    return { eventId, action: 'attach' };
  }
  const strong = ranked.find(({ evidence }) => {
    if (evidence.phaseConflict || evidence.multiTopic) return false;
    const contentConfirmed = evidence.contentOverlap >= EVENT_CLUSTER_STRONG_CONTENT_OVERLAP
      && evidence.contentJaccard >= EVENT_CLUSTER_STRONG_CONTENT_JACCARD;
    const titleConfirmed = evidence.sharedAnchors.length > 0
      && evidence.titleOverlap >= EVENT_CLUSTER_STRONG_TITLE_OVERLAP
      && evidence.daysApart <= EVENT_CLUSTER_STRONG_TITLE_DAYS;
    return contentConfirmed || titleConfirmed;
  });
  if (strong) {
    const confidence = Math.min(99, Math.round(65
      + strong.evidence.titleOverlap * 15
      + strong.evidence.contentOverlap * 12
      + strong.evidence.contentJaccard * 8));
    const eventId = await db.$transaction((tx) => attachArticle(tx, article, strong.candidate, 'rule', confidence, strong.evidence));
    return { eventId, action: 'attach' };
  }
  const ambiguous = ranked.filter(({ evidence }) => !evidence.multiTopic && (
    evidence.eventKeyMatch
    || (evidence.sharedAnchors.length > 0 && evidence.titleOverlap >= EVENT_CLUSTER_AMBIGUOUS_TITLE_OVERLAP)
    || evidence.contentOverlap >= EVENT_CLUSTER_AMBIGUOUS_CONTENT_OVERLAP
  )).slice(0, 2);
  const aiCandidates: AiCandidateAudit[] = [];
  for (const item of ambiguous) {
    let decision;
    try {
      decision = await askAiSameEvent(article, item.candidate, signal);
    } catch (error) {
      console.warn('[event-clustering] candidate decision failed:', error);
      aiCandidates.push({
        candidateEventId: item.candidate.id,
        ruleEvidence: item.evidence,
        aiDecision: { sameEvent: false, confidence: 0, reason: 'AI 判断失败，已保守分开', eventKey: '' },
      });
      continue;
    }
    const auditDecision = {
      candidateEventId: item.candidate.id,
      ruleEvidence: item.evidence,
      aiDecision: {
        sameEvent: decision.same_event,
        confidence: decision.confidence,
        reason: decision.reason,
        eventKey: decision.event_key,
      },
    };
    aiCandidates.push(auditDecision);
    if (decision.same_event && decision.confidence >= 70) {
      if (decision.event_key && decision.event_key !== eventKey) {
        await db.article.update({ where: { id: article.id }, data: { eventKey: decision.event_key } });
      }
      const eventId = await db.$transaction((tx) => attachArticle(tx, article, item.candidate, 'ai', decision.confidence, buildAiClusterAuditEvidence(aiCandidates, item.candidate.id)));
      return { eventId, action: 'attach' };
    }
  }
  const needsReview = ambiguous.length > 0 && aiCandidates.some((candidate) => (
    candidate.aiDecision.confidence > 0 && candidate.aiDecision.confidence < 75
  ));
  const eventId = await db.$transaction((tx) => createEventForArticle(tx, { ...article, eventKey }, {
    action: needsReview ? 'fallback_create' : 'create',
    decisionSource: needsReview ? 'ai' : 'rule',
    confidence: needsReview ? 50 : 90,
    evidence: { eventKey, ...buildAiClusterAuditEvidence(aiCandidates, null) },
    needsReview,
    candidateEventId: aiCandidates[0]?.candidateEventId,
  }));
  return { eventId, action: needsReview ? 'fallback_create' : 'create' };
}

export async function markClusterFailure(articleId: string, error: unknown): Promise<void> {
  const current = await db.article.findUnique({ where: { id: articleId }, select: { clusterRetryCount: true } });
  if (!current) return;
  const retryCount = current.clusterRetryCount + 1;
  const exhausted = retryCount >= EVENT_CLUSTER_MAX_RETRIES;
  const retryDelay = Math.min(2 ** retryCount, 360) * 60_000;
  await db.article.update({
    where: { id: articleId },
    data: {
      clusterStatus: 'failed',
      clusterError: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      clusterRetryCount: retryCount,
      nextClusterRetryAt: exhausted ? null : new Date(Date.now() + retryDelay),
    },
  });
}
