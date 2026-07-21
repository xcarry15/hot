import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  EVENT_CLUSTER_MAX_CANDIDATES,
  EVENT_CLUSTER_MAX_AI_CANDIDATES,
  EVENT_CLUSTER_MAX_MEMBER_ARTICLES,
  EVENT_CLUSTER_CONTENT_RECALL_CANDIDATES,
  EVENT_CLUSTER_MAX_RETRIES,
  EVENT_CLUSTER_AMBIGUOUS_CONTENT_OVERLAP,
  EVENT_CLUSTER_AMBIGUOUS_IDENTITY_SCORE,
  EVENT_CLUSTER_AMBIGUOUS_TITLE_OVERLAP,
  EVENT_CLUSTER_MIN_KEY_CONFIDENCE,
  EVENT_CLUSTER_RULE_VERSION,
  EVENT_CLUSTER_STRONG_CONTENT_JACCARD,
  EVENT_CLUSTER_STRONG_CONTENT_OVERLAP,
  EVENT_CLUSTER_STRONG_IDENTITY_SCORE,
  EVENT_CLUSTER_STRONG_TITLE_DAYS,
  EVENT_CLUSTER_STRONG_TITLE_OVERLAP,
  EVENT_CLUSTER_WINDOW_DAYS,
  contentShingleSimilarity,
  hasEventIdentityQualifierConflict,
  hasLiteralContentOverlap,
  hasEventPhaseConflict,
  isMultiTopicTitle,
  normalizeEventText,
  overlapCoefficient,
  sharedEventAnchors,
} from '@/contracts/event-clustering';
import { parseEventSubjects } from '@/contracts/event-identity';
import { createChatCompletion } from '@/lib/ai-client';
import { parseStrictJsonObject } from '@/lib/ai-helpers';
import { db } from '@/lib/db';
import { recalculateEventById } from '@/lib/event-service';

const aiDecisionSchema = z.object({
  same_event: z.boolean(),
  confidence: z.number().int().min(0).max(100),
  reason: z.string().trim().max(50),
}).strict();

type ClusterClient = Pick<Prisma.TransactionClient, 'article' | 'event' | 'eventClusterAudit'>;

type Candidate = {
  id: string;
  representativeArticleId: string | null;
  clusterReviewStatus: string;
  articles: Array<{
    id: string;
    title: string;
    cleanContent: string;
    contentHash: string;
    eventSubjects: string;
    eventAction: string;
    eventObject: string;
    eventKey: string;
    eventKeyConfidence: number | null;
    publishedAt: Date | null;
    createdAt: Date;
  }>;
};

const candidateArticleSelect = {
  id: true,
  title: true,
  cleanContent: true,
  contentHash: true,
  eventSubjects: true,
  eventAction: true,
  eventObject: true,
  eventKey: true,
  eventKeyConfidence: true,
  publishedAt: true,
  createdAt: true,
} as const;

export interface AiCandidateAudit {
  candidateEventId: string;
  ruleEvidence: {
    exactTitle: boolean;
    fingerprint: boolean;
    eventKeyMatch: boolean;
    subjectOverlap: number;
    actionOverlap: number;
    objectOverlap: number;
    identityScore: number;
    identityConfidence: number;
    qualifierConflict: boolean;
    identityConflict: boolean;
    titleOverlap: number;
    contentOverlap: number;
    contentJaccard: number;
    daysApart: number;
    phaseConflict: boolean;
    multiTopic: boolean;
    sharedAnchors: string[];
  };
  aiDecision: { sameEvent: boolean; confidence: number; reason: string };
}

export function shouldCreateClusterReview(
  ambiguousCount: number,
  aiCandidates: Pick<AiCandidateAudit, 'aiDecision'>[],
): boolean {
  if (ambiguousCount === 0) return false;
  const hasAiFailure = aiCandidates.some((candidate) => candidate.aiDecision.confidence === 0);
  const allAmbiguousConfidentlyDifferent = aiCandidates.length === ambiguousCount
    && aiCandidates.every((candidate) => (
      !candidate.aiDecision.sameEvent && candidate.aiDecision.confidence >= 85
    ));
  return hasAiFailure || !allAmbiguousConfidentlyDifferent;
}

export function buildAiClusterAuditEvidence(candidates: AiCandidateAudit[], selectedCandidateEventId: string | null) {
  return { selectedCandidateEventId, candidates: [...candidates] };
}

function articleDate(article: { publishedAt: Date | null; createdAt: Date }): Date {
  return article.publishedAt ?? article.createdAt;
}

type IdentityArticle = {
  eventSubjects: string;
  eventAction: string;
  eventObject: string;
  eventKeyConfidence: number | null;
};

function componentSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeEventText(left);
  const normalizedRight = normalizeEventText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  return overlapCoefficient(left, right);
}

function subjectSimilarity(left: string, right: string): number {
  const leftSubjects = parseEventSubjects(left);
  const rightSubjects = parseEventSubjects(right);
  if (leftSubjects.length === 0 || rightSubjects.length === 0) return 0;
  const directionalAverage = (from: string[], to: string[]) => from.reduce((sum, subject) => (
    sum + Math.max(...to.map((candidate) => componentSimilarity(subject, candidate)))
  ), 0) / from.length;
  // 联合事件必须覆盖双方主体；只共享一个品牌不能把不同合作方的事件合并。
  return Math.min(
    directionalAverage(leftSubjects, rightSubjects),
    directionalAverage(rightSubjects, leftSubjects),
  );
}

function compareIdentity(left: IdentityArticle, right: IdentityArticle) {
  const subjectOverlap = subjectSimilarity(left.eventSubjects, right.eventSubjects);
  const actionOverlap = componentSimilarity(left.eventAction, right.eventAction);
  const objectOverlap = componentSimilarity(left.eventObject, right.eventObject);
  const identityConfidence = Math.min(left.eventKeyConfidence ?? 0, right.eventKeyConfidence ?? 0);
  const identityScore = subjectOverlap * 0.45 + actionOverlap * 0.25 + objectOverlap * 0.3;
  const qualifierConflict = hasEventIdentityQualifierConflict(left.eventObject, right.eventObject);
  return {
    subjectOverlap,
    actionOverlap,
    objectOverlap,
    identityScore,
    identityConfidence,
    qualifierConflict,
    identityConflict: identityConfidence >= EVENT_CLUSTER_MIN_KEY_CONFIDENCE
      && (subjectOverlap < 0.35 || qualifierConflict),
  };
}

function candidateEvidence(
  article: { title: string; cleanContent: string; contentHash: string; eventSubjects: string; eventAction: string; eventObject: string; eventKey: string; eventKeyConfidence: number | null; publishedAt: Date | null; createdAt: Date },
  candidate: Candidate,
  includeContent = true,
) {
  const normalizedTitle = normalizeEventText(article.title);
  let exactTitle = false;
  let fingerprint = false;
  let eventKeyMatch = false;
  let subjectOverlap = 0;
  let actionOverlap = 0;
  let objectOverlap = 0;
  let identityScore = 0;
  let identityConfidence = 0;
  let qualifierConflict = false;
  let identityConflict = false;
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
    const identity = compareIdentity(article, member);
    if (identity.identityScore > identityScore) {
      subjectOverlap = identity.subjectOverlap;
      actionOverlap = identity.actionOverlap;
      objectOverlap = identity.objectOverlap;
      identityScore = identity.identityScore;
      identityConfidence = identity.identityConfidence;
      qualifierConflict = identity.qualifierConflict;
      identityConflict = identity.identityConflict;
    }
    titleOverlap = Math.max(titleOverlap, overlapCoefficient(article.title, member.title));
    if (includeContent) {
      const content = contentShingleSimilarity(article.cleanContent, member.cleanContent);
      contentOverlap = Math.max(contentOverlap, content.overlap);
      contentJaccard = Math.max(contentJaccard, content.jaccard);
    }
    daysApart = Math.min(daysApart, Math.abs(articleDate(article).getTime() - articleDate(member).getTime()) / 86_400_000);
    phaseConflict ||= hasEventPhaseConflict(
      `${article.title} ${article.eventAction} ${article.eventObject}`,
      `${member.title} ${member.eventAction} ${member.eventObject}`,
    );
    multiTopic ||= isMultiTopicTitle(member.title);
    const anchors = sharedEventAnchors(article.title, member.title);
    if (anchors.length > sharedAnchors.length) sharedAnchors = anchors;
  }
  return {
    exactTitle,
    fingerprint,
    eventKeyMatch,
    subjectOverlap,
    actionOverlap,
    objectOverlap,
    identityScore,
    identityConfidence,
    qualifierConflict,
    identityConflict,
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

function isStrongPushedDuplicate(evidence: ReturnType<typeof candidateEvidence>): boolean {
  if (evidence.fingerprint) return true;
  if (evidence.phaseConflict || evidence.identityConflict) return false;
  if (evidence.eventKeyMatch && evidence.identityConfidence >= EVENT_CLUSTER_MIN_KEY_CONFIDENCE) return true;
  if (evidence.identityScore >= 0.84
    && evidence.subjectOverlap >= 0.75
    && evidence.actionOverlap >= 0.6
    && evidence.objectOverlap >= 0.7) return true;
  return evidence.sharedAnchors.length > 0
    && evidence.titleOverlap >= 0.9
    && evidence.contentOverlap >= 0.78
    && evidence.contentJaccard >= 0.5;
}

/**
 * 推送前的跨 Event 最后防线。它只拦截高置信的已推送重复，不参与正常聚类，
 * 也不改变 Event 归属；人工强制推送仍由调用方明确绕过。
 */
export async function findRecentPushedEventDuplicate(articleId: string, eventId: string): Promise<{
  eventId: string;
  evidence: ReturnType<typeof candidateEvidence>;
} | null> {
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      title: true,
      cleanContent: true,
      contentHash: true,
      eventSubjects: true,
      eventAction: true,
      eventObject: true,
      eventKey: true,
      eventKeyConfidence: true,
      publishedAt: true,
      createdAt: true,
    },
  });
  if (!article) return null;
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const rows = await db.event.findMany({
    where: {
      id: { not: eventId },
      status: 'active',
      pushedAt: { not: null, gte: cutoff },
    },
    select: {
      id: true,
      representativeArticleId: true,
      clusterReviewStatus: true,
      representativeArticle: { select: candidateArticleSelect },
      articles: {
        where: { clusterStatus: { in: ['clustered', 'needs_review'] }, aiStatus: 'done' },
        orderBy: { createdAt: 'desc' },
        take: EVENT_CLUSTER_MAX_MEMBER_ARTICLES,
        select: candidateArticleSelect,
      },
    },
  });
  const matches = rows
    .map(({ representativeArticle, articles, ...event }) => {
      const candidate: Candidate = {
        ...event,
        articles: [
          ...(representativeArticle ? [representativeArticle] : []),
          ...articles,
        ].filter((member, index, all) => all.findIndex((item) => item.id === member.id) === index),
      };
      return { eventId: event.id, evidence: candidateEvidence(article, candidate) };
    })
    .filter((match) => isStrongPushedDuplicate(match.evidence))
    .sort((left, right) => {
      const score = (evidence: ReturnType<typeof candidateEvidence>) => Number(evidence.fingerprint) * 10
        + Number(evidence.eventKeyMatch) * 8
        + evidence.identityScore * 6
        + evidence.contentOverlap * 3
        + evidence.titleOverlap * 2;
      return score(right.evidence) - score(left.evidence);
    });
  return matches[0] ?? null;
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
      clusterReviewStatus: input.needsReview ? 'pending' : 'confirmed',
      // AI 已完成；事务结束后由 event-service 统一选择代表文章并刷新公开状态。
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
  const clusterReviewStatus = candidate.clusterReviewStatus === 'pending' ? 'pending' : 'confirmed';
  await client.article.update({
    where: { id: article.id },
    data: {
      eventId: candidate.id,
      clusterStatus: clusterReviewStatus === 'pending' ? 'needs_review' : 'clustered',
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
      clusterReviewStatus,
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
  article: { title: string; cleanContent: string; eventKey: string; eventKeyConfidence: number | null },
  candidate: Candidate,
  signal?: AbortSignal,
) {
  const candidateArticles = candidate.articles.slice(0, 3).map((item) => `- 事件键：${item.eventKey}（置信度 ${item.eventKeyConfidence ?? 0}）\n  标题：${item.title}\n  正文：${item.cleanContent.slice(0, 600)}`).join('\n');
  const prompt = `判断是否是同一个具体新闻事件。
同一事件必须同时满足：核心主体相同、具体动作/结果相同、时间阶段一致。
以下均不算同一事件：只有品牌/地点/奖项/话题相同；预告与事后结果；聚合快讯仅有一个子项重合。
证据不足时返回 false 且 confidence 不超过 60；只有存在明确冲突时才返回 false 且 confidence 至少 85。

新文章事件键：${article.eventKey}（置信度 ${article.eventKeyConfidence ?? 0}）
新文章：${article.title}
正文：${article.cleanContent.slice(0, 1_200)}

候选报道：
${candidateArticles}

只返回 JSON：{"same_event":false,"confidence":0,"reason":"不超过50字"}`;
  const result = await createChatCompletion([
    { role: 'system', content: '你是保守的新闻事件聚类器，只根据给定文本判断，证据不足时分开。' },
    { role: 'user', content: prompt },
  ], { temperature: 0, maxTokens: 300, responseFormat: 'json_object', signal });
  return aiDecisionSchema.parse(parseStrictJsonObject(result.content));
}

export async function clusterArticle(articleId: string, signal?: AbortSignal): Promise<{ eventId: string; action: string }> {
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      title: true,
      cleanContent: true,
      contentHash: true,
      eventSubjects: true,
      eventAction: true,
      eventObject: true,
      eventKey: true,
      eventKeyConfidence: true,
      publishedAt: true,
      createdAt: true,
      clusterStatus: true,
      aiStatus: true,
    },
  });
  if (!article) throw new Error('文章不存在');
  if (article.aiStatus !== 'done' || !article.eventKey) throw new Error('文章尚未完成事件身份分析');
  if (article.clusterStatus === 'clustered' || article.clusterStatus === 'needs_review') {
    const current = await db.article.findUnique({ where: { id: article.id }, select: { eventId: true } });
    if (current?.eventId) return { eventId: current.eventId, action: 'existing' };
  }

  const multiTopic = isMultiTopicTitle(article.title);
  if (multiTopic) {
    const eventId = await db.$transaction((tx) => createEventForArticle(tx, article, {
      action: 'fallback_create',
      decisionSource: 'rule',
      confidence: 50,
      evidence: {
        eventKey: article.eventKey,
        multiTopic: true,
        reason: '标题包含多个独立主体与动作，不能自动归入单一 Event',
        ...buildAiClusterAuditEvidence([], null),
      },
      needsReview: true,
    }));
    await recalculateEventById(eventId);
    return { eventId, action: 'fallback_create' };
  }
  const referenceAt = articleDate(article);
  const windowMs = EVENT_CLUSTER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const windowStart = new Date(referenceAt.getTime() - windowMs);
  const windowEnd = new Date(referenceAt.getTime() + windowMs);
  const candidateRows = await db.event.findMany({
    where: {
      status: 'active',
      firstSeenAt: { lte: windowEnd },
      lastSeenAt: { gte: windowStart },
      articles: { some: {
        clusterStatus: { in: ['clustered', 'needs_review'] },
        aiStatus: 'done',
      } },
    },
    select: {
      id: true,
      representativeArticleId: true,
      clusterReviewStatus: true,
      representativeArticle: { select: candidateArticleSelect },
      articles: {
        where: {
          clusterStatus: { in: ['clustered', 'needs_review'] },
          aiStatus: 'done',
        },
        orderBy: { createdAt: 'desc' },
        take: EVENT_CLUSTER_MAX_MEMBER_ARTICLES,
        select: candidateArticleSelect,
      },
    },
    orderBy: { lastSeenAt: 'desc' },
  });
  const candidates: Candidate[] = candidateRows.map(({ representativeArticle, articles, ...candidate }) => ({
    ...candidate,
    articles: [
      ...(representativeArticle ? [representativeArticle] : []),
      ...articles,
    ].filter((member, index, all) => all.findIndex((item) => item.id === member.id) === index),
  }));
  const recalled = candidates
    .map((candidate) => ({
      candidate,
      evidence: candidateEvidence(article, candidate, false),
      contentHint: hasCandidateContentHint(article, candidate),
    }))
    .sort((left, right) => {
      const score = (value: typeof left.evidence) => Number(value.fingerprint) * 5
        + Number(value.exactTitle) * 4
        + Number(value.eventKeyMatch) * 8
        + value.identityScore * 6
        + value.subjectOverlap * 2
        + value.titleOverlap * 1.5
        + Math.min(value.sharedAnchors.length, 3)
        - Number(value.phaseConflict) * 3
        - Number(value.identityConflict) * 5
        - Number(value.multiTopic) * 1.5
        - Math.min(value.daysApart, EVENT_CLUSTER_WINDOW_DAYS) / EVENT_CLUSTER_WINDOW_DAYS;
      return Number(right.contentHint) * 4 + score(right.evidence)
        - (Number(left.contentHint) * 4 + score(left.evidence));
    })
    .slice(0, EVENT_CLUSTER_CONTENT_RECALL_CANDIDATES);
  const ranked = recalled
    .map(({ candidate }) => ({ candidate, evidence: candidateEvidence(article, candidate) }))
    .sort((left, right) => {
      const score = (value: typeof left.evidence) => Number(value.fingerprint) * 5
        + Number(value.exactTitle) * 4
        + Number(value.eventKeyMatch) * 8
        + value.identityScore * 6
        + value.contentOverlap * 3
        + value.contentJaccard * 2
        + value.titleOverlap
        - Number(value.phaseConflict) * 3
        - Number(value.identityConflict) * 5
        - Number(value.multiTopic) * 1.5;
      return score(right.evidence) - score(left.evidence);
    })
    .slice(0, EVENT_CLUSTER_MAX_CANDIDATES);

  const exact = ranked.find(({ evidence }) => evidence.fingerprint || (
    evidence.exactTitle
    && !evidence.phaseConflict
    && !evidence.identityConflict
    && (evidence.eventKeyMatch || evidence.identityScore >= EVENT_CLUSTER_STRONG_IDENTITY_SCORE)
  ));
  if (exact) {
    const eventId = await db.$transaction((tx) => attachArticle(tx, article, exact.candidate, 'exact', 100, exact.evidence));
    await recalculateEventById(eventId);
    return { eventId, action: 'attach' };
  }
  const strong = ranked.find(({ evidence }) => {
    if (evidence.phaseConflict || evidence.identityConflict || evidence.multiTopic) return false;
    const keyConfirmed = evidence.eventKeyMatch
      && evidence.identityConfidence >= EVENT_CLUSTER_MIN_KEY_CONFIDENCE;
    const identityConfirmed = evidence.identityConfidence >= EVENT_CLUSTER_MIN_KEY_CONFIDENCE
      && evidence.identityScore >= EVENT_CLUSTER_STRONG_IDENTITY_SCORE
      && evidence.subjectOverlap >= 0.6
      && evidence.actionOverlap >= 0.5
      && evidence.objectOverlap >= 0.45;
    const contentConfirmed = evidence.contentOverlap >= EVENT_CLUSTER_STRONG_CONTENT_OVERLAP
      && evidence.contentJaccard >= EVENT_CLUSTER_STRONG_CONTENT_JACCARD;
    const titleConfirmed = evidence.sharedAnchors.length > 0
      && evidence.titleOverlap >= EVENT_CLUSTER_STRONG_TITLE_OVERLAP
      && evidence.daysApart <= EVENT_CLUSTER_STRONG_TITLE_DAYS
      && evidence.identityScore >= 0.6
      && evidence.actionOverlap >= 0.45
      && evidence.objectOverlap >= 0.65;
    return keyConfirmed || identityConfirmed || contentConfirmed || titleConfirmed;
  });
  if (strong) {
    const confidence = Math.min(99, Math.round(65
      + Number(strong.evidence.eventKeyMatch) * 20
      + strong.evidence.identityScore * 12
      + strong.evidence.titleOverlap * 6
      + strong.evidence.contentOverlap * 5));
    const eventId = await db.$transaction((tx) => attachArticle(tx, article, strong.candidate, 'rule', confidence, strong.evidence));
    await recalculateEventById(eventId);
    return { eventId, action: 'attach' };
  }
  const ambiguous = ranked.filter(({ evidence }) => !evidence.multiTopic
    && !evidence.phaseConflict
    && !evidence.identityConflict
    && (
      evidence.eventKeyMatch
      || evidence.identityScore >= EVENT_CLUSTER_AMBIGUOUS_IDENTITY_SCORE
      || (evidence.sharedAnchors.length > 0 && evidence.titleOverlap >= EVENT_CLUSTER_AMBIGUOUS_TITLE_OVERLAP)
      || evidence.contentOverlap >= EVENT_CLUSTER_AMBIGUOUS_CONTENT_OVERLAP
    )).slice(0, EVENT_CLUSTER_MAX_AI_CANDIDATES);
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
        aiDecision: { sameEvent: false, confidence: 0, reason: 'AI 判断失败，已保守分开' },
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
      },
    };
    aiCandidates.push(auditDecision);
    if (decision.same_event && decision.confidence >= 70) {
      const eventId = await db.$transaction((tx) => attachArticle(tx, article, item.candidate, 'ai', decision.confidence, buildAiClusterAuditEvidence(aiCandidates, item.candidate.id)));
      await recalculateEventById(eventId);
      return { eventId, action: 'attach' };
    }
  }
  // 灰区只有在每个候选都得到高置信“不同事件”结论时才允许新建正常 Event。
  // AI 超时、格式错误或低置信结论必须进入待复核，不能降级成可推送事件。
  const needsReview = shouldCreateClusterReview(ambiguous.length, aiCandidates);
  const eventId = await db.$transaction((tx) => createEventForArticle(tx, article, {
    action: needsReview ? 'fallback_create' : 'create',
    decisionSource: needsReview ? 'ai' : 'rule',
    confidence: needsReview ? 50 : 90,
    evidence: {
      eventKey: article.eventKey,
      eventKeyConfidence: article.eventKeyConfidence,
      eventIdentity: {
        subjects: parseEventSubjects(article.eventSubjects),
        action: article.eventAction,
        object: article.eventObject,
      },
      ...buildAiClusterAuditEvidence(aiCandidates, null),
    },
    needsReview,
    candidateEventId: aiCandidates[0]?.candidateEventId,
  }));
  await recalculateEventById(eventId);
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
