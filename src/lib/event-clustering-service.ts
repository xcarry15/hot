import { Prisma } from '@prisma/client';
import {
  EVENT_CLUSTER_MAX_CANDIDATES,
  EVENT_CLUSTER_MAX_MEMBER_ARTICLES,
  EVENT_CLUSTER_CONTENT_RECALL_CANDIDATES,
  EVENT_CLUSTER_FOLLOW_UP_DAYS,
  EVENT_CLUSTER_MAX_RETRIES,
  EVENT_CLUSTER_RULE_VERSION,
  EVENT_CLUSTER_WINDOW_DAYS,
  hasLiteralContentOverlap,
  isMultiTopicTitle,
} from '@/contracts/event-clustering';
import { parseEventSubjects } from '@/contracts/event-identity';
import { db } from '@/lib/db';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { refreshEventPublicPublication } from '@/lib/public-publication-service';
import { recalculateEvent } from '@/lib/event/event-recalculation-service';
import { markEventDirty, repairAttachedClusterArticle } from '@/lib/event/event-consistency-service';
import { assertNotAborted } from '@/lib/worker-stop';
import {
  articleDate,
  bestPairEvidenceForCandidate,
  buildRuleCandidateAuditEvidence,
  candidateArticleSelect,
  isStrongPushedDuplicate,
  isReviewWorthyCandidate,
  type Candidate,
  type PairEvidence,
  type RuleCandidateAudit,
} from '@/lib/event/event-cluster-evidence';
export {
  buildRuleCandidateAuditEvidence,
  hasDuplicateReportEvidence,
  isNearExactReprint,
  isReviewWorthyCandidate,
  isStrongEventKeyDuplicate,
  type RuleCandidateAudit,
} from '@/lib/event/event-cluster-evidence';

type ClusterClient = Prisma.TransactionClient;


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
  input: { action: 'create' | 'fallback_create'; decisionSource: 'rule' | 'ai'; confidence: number | null; evidence: object; needsReview?: boolean; candidateEventId?: string; matchedMemberArticleId?: string },
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
      skipReason: null,
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
  decisionSource: 'exact' | 'rule',
  confidence: number | null,
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
      skipReason: null,
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

export async function clusterArticle(articleId: string, signal?: AbortSignal): Promise<{ eventId: string; action: string }> {
  assertNotAborted(signal);
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
  if (article.aiStatus !== 'done') throw new Error('文章尚未完成 AI 分析');
  if (article.clusterStatus === 'clustered' || article.clusterStatus === 'needs_review') {
    const current = await db.article.findUnique({ where: { id: article.id }, select: { eventId: true } });
    if (current?.eventId) return { eventId: current.eventId, action: 'existing' };
  }

  const multiTopic = isMultiTopicTitle(article.title);
  if (multiTopic || !article.eventKey) {
    assertNotAborted(signal);
    const eventId = await commitClusterMutation((tx) => createEventForArticle(tx, article, {
      action: 'create',
      decisionSource: 'rule',
      confidence: null,
      evidence: {
        eventKey: article.eventKey,
        multiTopic,
        standalone: true,
        reason: multiTopic
          ? '标题包含多个独立主体与动作，不强行归入其中一个子事件，自动按单篇建立独立 Event'
          : '未提取到完整事件身份，自动按单篇建立独立 Event',
        ...buildRuleCandidateAuditEvidence([], null),
      },
    }));
    return { eventId, action: 'create' };
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
  assertNotAborted(signal);
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
    assertNotAborted(signal);
    const eventId = await commitClusterMutation((tx) => attachArticle(tx, article, exact.candidate, exact.evidence, 'exact', null));
    return { eventId, action: 'attach' };
  }

  const strong = ranked.find(({ evidence }) => evidence.decision === 'strong');
  if (strong) {
    assertNotAborted(signal);
    const eventId = await commitClusterMutation((tx) => attachArticle(tx, article, strong.candidate, strong.evidence, 'rule', null));
    return { eventId, action: 'attach' };
  }

  // 事件候选只使用主分析已提取的身份和本地证据。无法安全确认独立事件时
  // 必须进入待复核，避免候选关系被 confirmed Event 吞掉后直接公开或推送。
  const nearbyCandidates: RuleCandidateAudit[] = ranked
    .filter(({ evidence }) => isReviewWorthyCandidate(evidence))
    .map(({ candidate, evidence }) => ({
      candidateEventId: candidate.id,
      matchedMemberArticleId: evidence.matchedMemberArticleId,
      ruleEvidence: evidence as unknown as Record<string, unknown>,
    }));
  assertNotAborted(signal);
  const eventId = await commitClusterMutation((tx) => createEventForArticle(tx, article, {
    action: 'create',
    decisionSource: 'rule',
    confidence: null,
    evidence: {
      eventKey: article.eventKey,
      eventKeyConfidence: article.eventKeyConfidence,
      eventIdentity: {
        subjects: parseEventSubjects(article.eventSubjects),
        action: article.eventAction,
        object: article.eventObject,
      },
      reason: nearbyCandidates.length > 0
        ? '存在无法自动确认的相近候选，进入待复核并阻断公开/推送'
        : '未发现可自动归并的候选事件',
      ...buildRuleCandidateAuditEvidence(nearbyCandidates, null),
    },
    needsReview: nearbyCandidates.length > 0,
    candidateEventId: nearbyCandidates[0]?.candidateEventId,
  }));
  return { eventId, action: 'create' };
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
