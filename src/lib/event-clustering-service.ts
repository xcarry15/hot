import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  EVENT_CLUSTER_MAX_CANDIDATES,
  EVENT_CLUSTER_MAX_RETRIES,
  EVENT_CLUSTER_RULE_VERSION,
  EVENT_CLUSTER_WINDOW_DAYS,
  buildRuleEventKey,
  normalizeEventText,
  overlapCoefficient,
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

type Candidate = {
  id: string;
  representativeArticleId: string | null;
  articles: Array<{
    id: string;
    title: string;
    contentHash: string;
    eventKey: string;
  }>;
};

export interface AiCandidateAudit {
  candidateEventId: string;
  ruleEvidence: {
    exactTitle: boolean;
    fingerprint: boolean;
    eventKeyMatch: boolean;
    titleOverlap: number;
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
  article: { title: string; contentHash: string; eventKey: string },
  candidate: Candidate,
) {
  const normalizedTitle = normalizeEventText(article.title);
  let exactTitle = false;
  let fingerprint = false;
  let eventKeyMatch = false;
  let titleOverlap = 0;
  for (const member of candidate.articles) {
    exactTitle ||= normalizedTitle.length > 0 && normalizedTitle === normalizeEventText(member.title);
    fingerprint ||= article.contentHash.length > 0 && article.contentHash === member.contentHash;
    eventKeyMatch ||= article.eventKey.length > 0 && article.eventKey === member.eventKey;
    titleOverlap = Math.max(titleOverlap, overlapCoefficient(article.title, member.title));
  }
  return { exactTitle, fingerprint, eventKeyMatch, titleOverlap };
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
      representativeArticleId: article.id,
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
  const candidateTitles = candidate.articles.slice(0, 5).map((item) => `- ${item.title}`).join('\n');
  const prompt = `判断新文章与候选报道是否属于同一具体行业事件。\n\n同一事件必须是：同一主体、同一具体动作、同一事项。仅品牌或话题相同不算。\n\n新文章：${article.title}\n正文摘要：${article.cleanContent.slice(0, 800)}\n\n候选事件报道：\n${candidateTitles}\n\n只返回 JSON：{"same_event":true,"confidence":0,"event_key":"主体|动作|事项","reason":"简短理由"}`;
  const result = await createChatCompletion([
    { role: 'system', content: '你是严格保守的新闻事件聚类器。证据不足时判断为不同事件。' },
    { role: 'user', content: prompt },
  ], { temperature: 0, maxTokens: 300, signal });
  return aiDecisionSchema.parse(extractJsonObject(result.content));
}

async function generateEventKey(article: { title: string; cleanContent: string }, signal?: AbortSignal): Promise<string> {
  try {
    const result = await createChatCompletion([
      { role: 'system', content: '只提取新闻事件键，不解释。' },
      { role: 'user', content: `返回严格 JSON：{"event_key":"主体|动作|事项"}。无法可靠判断则返回空字符串。\n标题：${article.title}\n正文：${article.cleanContent.slice(0, 600)}` },
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

  const generatedKey = article.eventKey || await generateEventKey(article, signal);
  const eventKey = generatedKey || buildRuleEventKey(article.title);
  if (eventKey !== article.eventKey) await db.article.update({ where: { id: article.id }, data: { eventKey } });
  const since = new Date(Date.now() - EVENT_CLUSTER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await db.event.findMany({
    where: { status: 'active', lastSeenAt: { gte: since } },
    select: {
      id: true,
      representativeArticleId: true,
      articles: {
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, title: true, contentHash: true, eventKey: true },
      },
    },
    orderBy: { lastSeenAt: 'desc' },
  });
  const ranked = candidates
    .map((candidate) => ({ candidate, evidence: candidateEvidence({ ...article, eventKey }, candidate) }))
    .sort((left, right) => {
      const score = (value: typeof left.evidence) => Number(value.fingerprint) * 4 + Number(value.exactTitle) * 3 + Number(value.eventKeyMatch) * 2 + value.titleOverlap;
      return score(right.evidence) - score(left.evidence);
    })
    .slice(0, EVENT_CLUSTER_MAX_CANDIDATES);

  const exact = ranked.find(({ evidence }) => evidence.fingerprint || evidence.exactTitle);
  if (exact) {
    const eventId = await db.$transaction((tx) => attachArticle(tx, article, exact.candidate, 'exact', 100, exact.evidence));
    return { eventId, action: 'attach' };
  }
  const strong = ranked.find(({ evidence }) => evidence.eventKeyMatch && evidence.titleOverlap >= 0.72);
  if (strong) {
    const confidence = Math.round(70 + strong.evidence.titleOverlap * 30);
    const eventId = await db.$transaction((tx) => attachArticle(tx, article, strong.candidate, 'rule', confidence, strong.evidence));
    return { eventId, action: 'attach' };
  }
  const ambiguous = ranked.filter(({ evidence }) => evidence.eventKeyMatch || evidence.titleOverlap >= 0.42).slice(0, 2);
  const aiCandidates: AiCandidateAudit[] = [];
  for (const item of ambiguous) {
    const decision = await askAiSameEvent(article, item.candidate, signal);
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
  const needsReview = ambiguous.length > 0;
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
