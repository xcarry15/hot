import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  EVENT_CLUSTER_MAX_CANDIDATES,
  EVENT_CLUSTER_MAX_AI_CANDIDATES,
  EVENT_CLUSTER_MAX_MEMBER_ARTICLES,
  EVENT_CLUSTER_CONTENT_RECALL_CANDIDATES,
  EVENT_CLUSTER_FOLLOW_UP_DAYS,
  EVENT_CLUSTER_MAX_RETRIES,
  DEFAULT_EVENT_CLUSTER_AI_DIFFERENT_EVENT_CONFIDENCE,
  DEFAULT_EVENT_CLUSTER_AI_SAME_EVENT_CONFIDENCE,
  EVENT_CLUSTER_RULE_VERSION,
  EVENT_CLUSTER_WINDOW_DAYS,
  hasLiteralContentOverlap,
  isMultiTopicTitle,
} from '@/contracts/event-clustering';
import { parseEventSubjects } from '@/contracts/event-identity';
import { createChatCompletion } from '@/lib/ai-client';
import { parseStrictJsonObject } from '@/lib/ai-helpers';
import { db } from '@/lib/db';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { refreshEventPublicPublication } from '@/lib/public-publication-service';
import { recalculateEvent } from '@/lib/event/event-recalculation-service';
import { markEventDirty, repairAttachedClusterArticle } from '@/lib/event/event-consistency-service';
import { getSetting, SETTING_KEYS } from '@/lib/settings';
import {
  articleDate,
  bestPairEvidenceForCandidate,
  buildAiClusterAuditEvidence,
  candidateArticleSelect,
  isStrongPushedDuplicate,
  shouldCreateClusterReview,
  type AiCandidateAudit,
  type Candidate,
  type PairEvidence,
} from '@/lib/event/event-cluster-evidence';
export {
  buildAiClusterAuditEvidence,
  hasDuplicateReportEvidence,
  isAmbiguousEventCandidate,
  isNearExactReprint,
  isStrongEventKeyDuplicate,
  shouldCreateClusterReview,
  type AiCandidateAudit,
} from '@/lib/event/event-cluster-evidence';

const aiDecisionSchema = z.object({
  same_event: z.boolean(),
  confidence: z.number().int().min(0).max(100),
  // reason 仅用于审计展示；模型偶尔超出提示词字数，不应因此把有效判决
  // 降级成“AI 判断失败”。解析后统一截断即可。
  reason: z.string().trim().min(1).transform((value) => value.slice(0, 100)),
}).strict();

type ClusterClient = Prisma.TransactionClient;


type AiClusterThresholds = {
  sameEvent: number;
  differentEvent: number;
};

function parseThreshold(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

async function getAiClusterThresholds(): Promise<AiClusterThresholds> {
  const [sameEvent, differentEvent] = await Promise.all([
    getSetting(SETTING_KEYS.EVENT_CLUSTER_AI_SAME_EVENT_CONFIDENCE),
    getSetting(SETTING_KEYS.EVENT_CLUSTER_AI_DIFFERENT_EVENT_CONFIDENCE),
  ]);
  return {
    sameEvent: parseThreshold(sameEvent, DEFAULT_EVENT_CLUSTER_AI_SAME_EVENT_CONFIDENCE, 70, 95),
    differentEvent: parseThreshold(differentEvent, DEFAULT_EVENT_CLUSTER_AI_DIFFERENT_EVENT_CONFIDENCE, 70, 99),
  };
}


export async function findRecentPushedEventDuplicate(articleId: string, eventId: string): Promise<{
  eventId: string;
  evidence: PairEvidence;
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
  const candidateSelect = {
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
  } satisfies Prisma.EventSelect;
  const baseWhere = {
      id: { not: eventId },
      status: 'active',
      pushedAt: { not: null, gte: cutoff },
  } satisfies Prisma.EventWhereInput;
  const [exactRows, recentRows] = await Promise.all([
    db.event.findMany({
      where: {
        ...baseWhere,
        articles: { some: { clusterStatus: { in: ['clustered', 'needs_review'] }, aiStatus: 'done', eventKey: article.eventKey } },
      },
      select: candidateSelect,
      orderBy: { lastSeenAt: 'desc' },
      take: EVENT_CLUSTER_CONTENT_RECALL_CANDIDATES,
    }),
    db.event.findMany({
      where: baseWhere,
      select: candidateSelect,
      orderBy: { lastSeenAt: 'desc' },
      take: EVENT_CLUSTER_CONTENT_RECALL_CANDIDATES,
    }),
  ]);
  const rows = uniqueCandidateRows(exactRows, recentRows);
  const matches = rows
    .map(({ representativeArticle, articles, ...event }) => {
      const candidate: Candidate = {
        ...event,
        articles: [
          ...(representativeArticle ? [representativeArticle] : []),
          ...articles,
        ].filter((member, index, all) => all.findIndex((item) => item.id === member.id) === index),
      };
      const best = bestPairEvidenceForCandidate(article, candidate);
      return best ? { eventId: event.id, evidence: best } : null;
    })
    .filter((match): match is { eventId: string; evidence: PairEvidence } =>
      match !== null && isStrongPushedDuplicate(match.evidence))
    .sort((left, right) => {
      const score = (e: PairEvidence) => Number(e.fingerprintMatch) * 10
        + Number(e.eventKeyMatch) * 8
        + e.identityScore * 6
        + Math.max(e.charContentOverlap, e.tokenContentOverlap) * 3
        + e.titleOverlap * 2;
      return score(right.evidence) - score(left.evidence);
    });
  return matches[0] ?? null;
}

function uniqueCandidateRows<T extends { id: string }>(...groups: readonly T[][]): T[] {
  const seen = new Set<string>();
  return groups.flat().filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

/**
 * Event 成员归属、代表文章和计数属于同一份事实，必须一并提交。
 * 公开快照是派生缓存，失败时记录脏 Event 后异步修复，不再把已提交的聚类误标为失败。
 */
async function commitClusterMutation(mutate: (tx: ClusterClient) => Promise<string>): Promise<string> {
  const eventId = await db.$transaction(async (tx) => {
    const changedEventId = await mutate(tx);
    await recalculateEvent(tx, changedEventId);
    return changedEventId;
  });
  try {
    await refreshEventPublicPublication(eventId);
    invalidatePublicArticleCache();
  } catch (error) {
    console.error(`[event-clustering] public snapshot refresh deferred event=${eventId}:`, error);
    try {
      await markEventDirty(eventId, `public-snapshot-refresh: ${error instanceof Error ? error.message : String(error)}`);
    } catch (dirtyError) {
      console.error(`[event-clustering] failed to record dirty Event=${eventId}:`, dirtyError);
    }
  }
  return eventId;
}

async function createEventForArticle(
  client: ClusterClient,
  article: { id: string; title: string; publishedAt: Date | null; createdAt: Date; eventKey: string },
  input: { action: 'create' | 'fallback_create'; decisionSource: 'rule' | 'ai'; confidence?: number; evidence: object; needsReview?: boolean; candidateEventId?: string; matchedMemberArticleId?: string },
): Promise<string> {
  const seenAt = articleDate(article);
  const event = await client.event.create({
    data: {
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      articleCount: 1,
      clusterReviewStatus: input.needsReview ? 'pending' : 'confirmed',
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
      evidence: JSON.stringify({
        ruleVersion: EVENT_CLUSTER_RULE_VERSION,
        matchedMemberArticleId: input.matchedMemberArticleId,
        ...input.evidence,
      }),
    },
  });
  return event.id;
}

async function attachArticle(
  client: ClusterClient,
  article: { id: string; publishedAt: Date | null; createdAt: Date },
  candidate: Candidate,
  pair: PairEvidence,
  decisionSource: 'exact' | 'rule' | 'ai',
  confidence: number,
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
      evidence: JSON.stringify({
        ruleVersion: EVENT_CLUSTER_RULE_VERSION,
        matchedMemberArticleId: pair.matchedMemberArticleId,
        decision: pair.decision,
        pair,
      }),
    },
  });
  return candidate.id;
}

async function askAiSameEvent(
  article: { title: string; cleanContent: string; eventKey: string; eventKeyConfidence: number | null },
  pair: PairEvidence,
  candidate: Candidate,
  thresholds: AiClusterThresholds,
  signal?: AbortSignal,
) {
  const member = candidate.articles.find((item) => item.id === pair.matchedMemberArticleId) ?? candidate.articles[0];
  const prompt = `判断是否是同一个具体新闻事件。
同一事件必须同时满足：核心主体相同、具体动作/结果相同、时间阶段一致。
以下均不算同一事件：只有品牌/地点/奖项/话题相同；预告与事后结果；聚合快讯仅有一个子项重合。
证据不足时返回 false 且 confidence 不超过 60；只有存在明确冲突时才返回 false 且 confidence 至少 ${thresholds.differentEvent}。
只有同一事件证据充分时才返回 true，且 confidence 至少 ${thresholds.sameEvent}。

新文章事件键：${article.eventKey}（置信度 ${article.eventKeyConfidence ?? 0}）
新文章：${article.title}
正文：${article.cleanContent.slice(0, 1_200)}

匹配成员事件键：${member.eventKey}（置信度 ${member.eventKeyConfidence ?? 0}）
匹配成员标题：${member.title}
匹配成员正文：${member.cleanContent.slice(0, 600)}

只返回 JSON：{"same_event":false,"confidence":0,"reason":"不超过100字"}`;
  const result = await createChatCompletion([
    { role: 'system', content: '你是保守的新闻事件聚类器，只根据给定文本判断，证据不足时分开。' },
    { role: 'user', content: prompt },
  ], { temperature: 0, maxTokens: 300, responseFormat: 'json_object', signal });
  return aiDecisionSchema.parse(parseStrictJsonObject(result.content));
}

/**
 * AI 聚类判决后处理。提示词要求：
 * - same_event=true 时必须达到当前设置的自动归入阈值
 * - same_event=false 只有规则层已有明确冲突时，才可达到当前设置的独立事件阈值
 * 如果 AI 返回违反这些约束的组合，保守纠正。
 */
function hasExplicitDifferentEvidence(pair: PairEvidence): boolean {
  return pair.phaseConflict
    || pair.identityConflict
    || pair.qualifierConflict
    || pair.qualifierConflictOnPair;
}

function validateAiClusterDecision(
  raw: { same_event: boolean; confidence: number; reason: string },
  pair: PairEvidence,
  thresholds: AiClusterThresholds,
): {
  sameEvent: boolean; confidence: number; reason: string;
} {
  if (raw.same_event && raw.confidence < thresholds.sameEvent) {
    return { sameEvent: false, confidence: 0, reason: `AI 判断矛盾（sameEvent=true 但 confidence=${raw.confidence}<${thresholds.sameEvent}），已保守分开` };
  }
  if (!raw.same_event && raw.confidence >= thresholds.differentEvent && !hasExplicitDifferentEvidence(pair)) {
    return {
      sameEvent: false,
      confidence: 60,
      reason: `${raw.reason}（缺少明确身份冲突，按低置信不同事件处理）`,
    };
  }
  return { sameEvent: raw.same_event, confidence: raw.confidence, reason: raw.reason };
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
    const eventId = await commitClusterMutation((tx) => createEventForArticle(tx, article, {
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
    return { eventId, action: 'fallback_create' };
  }
  const referenceAt = articleDate(article);
  const windowMs = EVENT_CLUSTER_FOLLOW_UP_DAYS * 24 * 60 * 60 * 1000;
  const windowStart = new Date(referenceAt.getTime() - windowMs);
  const windowEnd = new Date(referenceAt.getTime() + windowMs);
  const candidateSelect = {
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
  } satisfies Prisma.EventSelect;
  const candidateBaseWhere = {
      status: 'active',
      firstSeenAt: { lte: windowEnd },
      lastSeenAt: { gte: windowStart },
      articles: { some: {
        clusterStatus: { in: ['clustered', 'needs_review'] },
        aiStatus: 'done',
      } },
  } satisfies Prisma.EventWhereInput;
  const [exactCandidateRows, recentCandidateRows] = await Promise.all([
    db.event.findMany({
      where: {
        ...candidateBaseWhere,
        articles: {
          some: {
            clusterStatus: { in: ['clustered', 'needs_review'] },
            aiStatus: 'done',
            eventKey: article.eventKey,
          },
        },
      },
      select: candidateSelect,
      orderBy: { lastSeenAt: 'desc' },
      take: EVENT_CLUSTER_CONTENT_RECALL_CANDIDATES,
    }),
    db.event.findMany({
      where: candidateBaseWhere,
      select: candidateSelect,
      orderBy: { lastSeenAt: 'desc' },
      take: EVENT_CLUSTER_CONTENT_RECALL_CANDIDATES,
    }),
  ]);
  const candidateRows = uniqueCandidateRows(exactCandidateRows, recentCandidateRows);
  const candidates: Candidate[] = candidateRows.map(({ representativeArticle, articles, ...candidate }) => ({
    ...candidate,
    articles: [
      ...(representativeArticle ? [representativeArticle] : []),
      ...articles,
    ].filter((member, index, all) => all.findIndex((item) => item.id === member.id) === index),
  }));

  // P0-2: 每个候选 Event 只保留一个最佳成员证据
  const bestEvidenceByEvent = new Map<string, PairEvidence>();
  for (const candidate of candidates) {
    const best = bestPairEvidenceForCandidate(article, candidate, false);
    if (best) bestEvidenceByEvent.set(candidate.id, best);
  }

  // Content recall: sort by composite score
  const recalled = candidates
    .filter((candidate) => bestEvidenceByEvent.has(candidate.id))
    .map((candidate) => {
      const evidence = bestEvidenceByEvent.get(candidate.id)!;
      return {
        candidate,
        evidence,
        contentHint: candidate.articles.some((member) => hasLiteralContentOverlap(article.cleanContent, member.cleanContent)),
      };
    })
    .sort((left, right) => {
      const score = (e: PairEvidence) => Number(e.fingerprintMatch) * 5
        + Number(e.exactTitle) * 4
        + Number(e.eventKeyMatch) * 8
        + e.identityScore * 6
        + e.subjectSimilarity * 2
        + e.titleOverlap * 1.5
        + Math.min(e.sharedAnchors.length, 3)
        - Number(e.phaseConflict) * 3
        - Number(e.identityConflict) * 5
        - Math.min(e.daysApart, EVENT_CLUSTER_WINDOW_DAYS) / EVENT_CLUSTER_WINDOW_DAYS;
      return Number(right.contentHint) * 4 + score(right.evidence)
        - (Number(left.contentHint) * 4 + score(left.evidence));
    })
    .slice(0, EVENT_CLUSTER_CONTENT_RECALL_CANDIDATES);

  // Full ranking with content
  const ranked = recalled
    .map(({ candidate }) => {
      const evidence = bestPairEvidenceForCandidate(article, candidate);
      return evidence ? { candidate, evidence } : null;
    })
    .filter((item): item is { candidate: Candidate; evidence: PairEvidence } => item !== null)
    .sort((left, right) => {
      const score = (e: PairEvidence) => Number(e.fingerprintMatch) * 5
        + Number(e.exactTitle) * 4
        + Number(e.eventKeyMatch) * 8
        + e.identityScore * 6
        + Math.max(e.charContentOverlap, e.tokenContentOverlap) * 3
        + Math.max(e.charContentJaccard, e.tokenContentJaccard) * 2
        + e.titleOverlap
        - Number(e.phaseConflict) * 3
        - Number(e.identityConflict) * 5;
      return score(right.evidence) - score(left.evidence);
    })
    .slice(0, EVENT_CLUSTER_MAX_CANDIDATES);

  // P0-2: 每位候选使用其最佳成员证据的决策
  const exact = ranked.find(({ evidence }) => evidence.decision === 'exact');
  if (exact) {
    const eventId = await commitClusterMutation((tx) => attachArticle(tx, article, exact.candidate, exact.evidence, 'exact', 100));
    return { eventId, action: 'attach' };
  }

  const strong = ranked.find(({ evidence }) => evidence.decision === 'strong');
  if (strong) {
    const confidence = Math.min(99, Math.round(65
      + Number(strong.evidence.eventKeyMatch) * 20
      + strong.evidence.identityScore * 12
      + strong.evidence.titleOverlap * 6
      + Math.max(strong.evidence.charContentOverlap, strong.evidence.tokenContentOverlap) * 5));
    const eventId = await commitClusterMutation((tx) => attachArticle(tx, article, strong.candidate, strong.evidence, 'rule', confidence));
    return { eventId, action: 'attach' };
  }

  const ambiguous = ranked
    .filter(({ evidence }) => evidence.decision === 'ambiguous')
    .slice(0, EVENT_CLUSTER_MAX_AI_CANDIDATES);

  const aiCandidates: AiCandidateAudit[] = [];
  const thresholds = ambiguous.length > 0 ? await getAiClusterThresholds() : null;
  for (const item of ambiguous) {
    let rawDecision;
    try {
      rawDecision = await askAiSameEvent(article, item.evidence, item.candidate, thresholds!, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn('[event-clustering] candidate decision failed:', error);
      aiCandidates.push({
        candidateEventId: item.candidate.id,
        matchedMemberArticleId: item.evidence.matchedMemberArticleId,
        ruleEvidence: item.evidence as unknown as Record<string, unknown>,
        aiDecision: { sameEvent: false, confidence: 0, reason: 'AI 判断失败，已保守分开' },
      });
      continue;
    }
    const decision = validateAiClusterDecision(rawDecision, item.evidence, thresholds!);
    const auditDecision: AiCandidateAudit = {
      candidateEventId: item.candidate.id,
      matchedMemberArticleId: item.evidence.matchedMemberArticleId,
      ruleEvidence: item.evidence as unknown as Record<string, unknown>,
      aiDecision: {
        sameEvent: decision.sameEvent,
        confidence: decision.confidence,
        reason: decision.reason,
      },
    };
    aiCandidates.push(auditDecision);
    if (decision.sameEvent && decision.confidence >= thresholds!.sameEvent) {
      const eventId = await commitClusterMutation((tx) => attachArticle(tx, article, item.candidate, item.evidence, 'ai', decision.confidence));
      return { eventId, action: 'attach' };
    }
  }

  const needsReview = shouldCreateClusterReview(
    ambiguous.length,
    aiCandidates,
    thresholds?.differentEvent,
  );
  const eventId = await commitClusterMutation((tx) => createEventForArticle(tx, article, {
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
  return { eventId, action: needsReview ? 'fallback_create' : 'create' };
}

export async function markClusterFailure(articleId: string, error: unknown): Promise<void> {
  const current = await db.article.findUnique({
    where: { id: articleId },
    select: { clusterRetryCount: true, eventId: true },
  });
  if (!current) return;
  // 防御旧版本“事务后重算失败”留下的半完成状态：有 Event 归属就先收敛，
  // 绝不能把它写成 eventId 非空的 failed，从而永久跳过恢复队列。
  if (current.eventId && await repairAttachedClusterArticle(articleId)) return;
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
