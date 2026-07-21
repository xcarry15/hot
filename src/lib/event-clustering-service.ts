import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  EVENT_CLUSTER_MAX_CANDIDATES,
  EVENT_CLUSTER_MAX_AI_CANDIDATES,
  EVENT_CLUSTER_MAX_MEMBER_ARTICLES,
  EVENT_CLUSTER_CONTENT_RECALL_CANDIDATES,
  EVENT_CLUSTER_MAX_RETRIES,
  EVENT_CLUSTER_AMBIGUOUS_CONTENT_OVERLAP,
  EVENT_CLUSTER_AMBIGUOUS_CONTENT_JACCARD,
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
  type ContentShingleResult,
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

/** P0-2: 每对成员独立的聚类证据——禁止跨成员拼接各维度最大值。 */
export interface PairEvidence {
  candidateEventId: string;
  matchedMemberArticleId: string;

  fingerprintMatch: boolean;
  eventKeyMatch: boolean;

  subjectSimilarity: number;
  actionSimilarity: number;
  objectSimilarity: number;
  identityScore: number;
  identityConfidence: number;
  identityConflict: boolean;
  qualifierConflict: boolean;

  titleOverlap: number;
  exactTitle: boolean;

  charContentOverlap: number;
  charContentJaccard: number;
  tokenContentOverlap: number;
  tokenContentJaccard: number;

  daysApart: number;
  phaseConflict: boolean;
  qualifierConflictOnPair: boolean;
  sharedAnchors: string[];

  /** P0-2: 该 pair 独立的判断：exact | strong | ambiguous | reject */
  decision: 'exact' | 'strong' | 'ambiguous' | 'reject';
}

export interface AiCandidateAudit {
  candidateEventId: string;
  matchedMemberArticleId: string;
  ruleEvidence: Record<string, unknown>;
  aiDecision: { sameEvent: boolean; confidence: number; reason: string };
}

export function isAmbiguousEventCandidate(evidence: {
  eventKeyMatch: boolean;
  identityConfidence: number;
  identityScore: number;
  subjectSimilarity: number;
  actionSimilarity: number;
  objectSimilarity: number;
  titleOverlap: number;
  daysApart: number;
  sharedAnchors: string[];
  charContentOverlap: number;
  charContentJaccard: number;
  tokenContentOverlap: number;
  tokenContentJaccard: number;
  phaseConflict: boolean;
  identityConflict: boolean;
  multiTopic: boolean;
}): boolean {
  if (evidence.multiTopic || evidence.phaseConflict || evidence.identityConflict) return false;

  const keySignal = evidence.eventKeyMatch
    && evidence.identityConfidence >= EVENT_CLUSTER_MIN_KEY_CONFIDENCE;
  const identitySignal = evidence.identityConfidence >= EVENT_CLUSTER_MIN_KEY_CONFIDENCE
    && evidence.identityScore >= EVENT_CLUSTER_AMBIGUOUS_IDENTITY_SCORE
    && evidence.subjectSimilarity >= 0.5
    && (evidence.actionSimilarity >= 0.4 || evidence.objectSimilarity >= 0.5);
  const titleSignal = evidence.sharedAnchors.length > 0
    && evidence.titleOverlap >= EVENT_CLUSTER_AMBIGUOUS_TITLE_OVERLAP
    && evidence.daysApart <= EVENT_CLUSTER_WINDOW_DAYS
    && evidence.identityScore >= 0.35;
  // P0-3: 要求同一表示空间中的指标同时成立
  const charContentSignal = evidence.charContentOverlap >= EVENT_CLUSTER_AMBIGUOUS_CONTENT_OVERLAP
    && evidence.charContentJaccard >= EVENT_CLUSTER_AMBIGUOUS_CONTENT_JACCARD;
  const tokenContentSignal = evidence.tokenContentOverlap >= EVENT_CLUSTER_AMBIGUOUS_CONTENT_OVERLAP
    && evidence.tokenContentJaccard >= EVENT_CLUSTER_AMBIGUOUS_CONTENT_JACCARD;
  const contentSignal = (charContentSignal || tokenContentSignal)
    && (evidence.sharedAnchors.length > 0 || evidence.identityScore >= 0.4);

  return keySignal || identitySignal || titleSignal || contentSignal;
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

/**
 * P0-2: 计算新文章与候选 Event 单个成员的 PairEvidence。
 * 不再跨成员取各维度最大值——每个 PairEvidence 独立评估。
 */
function computePairEvidence(
  article: { id: string; title: string; cleanContent: string; contentHash: string; eventSubjects: string; eventAction: string; eventObject: string; eventKey: string; eventKeyConfidence: number | null; publishedAt: Date | null; createdAt: Date },
  member: { id: string; title: string; cleanContent: string; contentHash: string; eventSubjects: string; eventAction: string; eventObject: string; eventKey: string; eventKeyConfidence: number | null; publishedAt: Date | null; createdAt: Date },
  candidateEventId: string,
  includeContent = true,
): PairEvidence {
  const normalizedTitle = normalizeEventText(article.title);
  const memberNormalizedTitle = normalizeEventText(member.title);

  const fingerprintMatch = article.contentHash.length > 0 && article.contentHash === member.contentHash;
  const eventKeyMatch = article.eventKey.length > 0 && article.eventKey === member.eventKey;
  const exactTitle = normalizedTitle.length > 0 && normalizedTitle === memberNormalizedTitle;

  const identity = compareIdentity(article, member);

  const titleOverlap = overlapCoefficient(article.title, member.title);

  let contentSimilarity: ContentShingleResult = {
    charOverlap: 0, charJaccard: 0, tokenOverlap: 0, tokenJaccard: 0,
  };
  if (includeContent) {
    contentSimilarity = contentShingleSimilarity(article.cleanContent, member.cleanContent);
  }

  const daysApart = Math.abs(articleDate(article).getTime() - articleDate(member).getTime()) / 86_400_000;

  const phaseConflict = hasEventPhaseConflict(
    `${article.title} ${article.eventAction} ${article.eventObject}`,
    `${member.title} ${member.eventAction} ${member.eventObject}`,
  );

  const multiTopic = isMultiTopicTitle(article.title) || isMultiTopicTitle(member.title);

  const sharedAnchors = sharedEventAnchors(article.title, member.title);

  const qualifierConflictOnPair = hasEventIdentityQualifierConflict(
    article.eventObject, member.eventObject,
  );

  // P0-2: 每个 pair 独立决策
  let decision: PairEvidence['decision'] = 'reject';

  const isExact = fingerprintMatch || (
    exactTitle
    && !phaseConflict
    && !identity.identityConflict
    && (eventKeyMatch || identity.identityScore >= EVENT_CLUSTER_STRONG_IDENTITY_SCORE)
  );
  if (isExact) {
    decision = 'exact';
  } else if (!phaseConflict && !identity.identityConflict && !multiTopic) {
    const keyConfirmed = eventKeyMatch
      && identity.identityConfidence >= EVENT_CLUSTER_MIN_KEY_CONFIDENCE;
    const identityConfirmed = identity.identityConfidence >= EVENT_CLUSTER_MIN_KEY_CONFIDENCE
      && identity.identityScore >= EVENT_CLUSTER_STRONG_IDENTITY_SCORE
      && identity.subjectOverlap >= 0.6
      && identity.actionOverlap >= 0.5
      && identity.objectOverlap >= 0.45;
    // P0-3: 要求同一表示空间的指标同时成立
    const charContentConfirmed = contentSimilarity.charOverlap >= EVENT_CLUSTER_STRONG_CONTENT_OVERLAP
      && contentSimilarity.charJaccard >= EVENT_CLUSTER_STRONG_CONTENT_JACCARD;
    const tokenContentConfirmed = contentSimilarity.tokenOverlap >= EVENT_CLUSTER_STRONG_CONTENT_OVERLAP
      && contentSimilarity.tokenJaccard >= EVENT_CLUSTER_STRONG_CONTENT_JACCARD;
    const titleConfirmed = sharedAnchors.length > 0
      && titleOverlap >= EVENT_CLUSTER_STRONG_TITLE_OVERLAP
      && daysApart <= EVENT_CLUSTER_STRONG_TITLE_DAYS
      && identity.identityScore >= 0.6
      && identity.actionOverlap >= 0.45
      && identity.objectOverlap >= 0.65;

    if (keyConfirmed || identityConfirmed || charContentConfirmed || tokenContentConfirmed || titleConfirmed) {
      decision = 'strong';
    } else if (isAmbiguousEventCandidate({
      eventKeyMatch,
      identityConfidence: identity.identityConfidence,
      identityScore: identity.identityScore,
      subjectSimilarity: identity.subjectOverlap,
      actionSimilarity: identity.actionOverlap,
      objectSimilarity: identity.objectOverlap,
      titleOverlap,
      daysApart: Number.isFinite(daysApart) ? daysApart : EVENT_CLUSTER_WINDOW_DAYS,
      sharedAnchors,
      charContentOverlap: contentSimilarity.charOverlap,
      charContentJaccard: contentSimilarity.charJaccard,
      tokenContentOverlap: contentSimilarity.tokenOverlap,
      tokenContentJaccard: contentSimilarity.tokenJaccard,
      phaseConflict,
      identityConflict: identity.identityConflict,
      multiTopic,
    })) {
      decision = 'ambiguous';
    }
  }

  return {
    candidateEventId,
    matchedMemberArticleId: member.id,
    fingerprintMatch,
    eventKeyMatch,
    subjectSimilarity: identity.subjectOverlap,
    actionSimilarity: identity.actionOverlap,
    objectSimilarity: identity.objectOverlap,
    identityScore: identity.identityScore,
    identityConfidence: identity.identityConfidence,
    identityConflict: identity.identityConflict,
    qualifierConflict: identity.qualifierConflict,
    titleOverlap,
    exactTitle,
    charContentOverlap: contentSimilarity.charOverlap,
    charContentJaccard: contentSimilarity.charJaccard,
    tokenContentOverlap: contentSimilarity.tokenOverlap,
    tokenContentJaccard: contentSimilarity.tokenJaccard,
    daysApart: Number.isFinite(daysApart) ? daysApart : EVENT_CLUSTER_WINDOW_DAYS,
    phaseConflict,
    qualifierConflictOnPair,
    sharedAnchors,
    decision,
  };
}

/**
 * P0-2: 从候选 Event 的所有成员中计算 PairEvidence，选择最佳成员证据。
 */
function bestPairEvidenceForCandidate(
  article: Parameters<typeof computePairEvidence>[0],
  candidate: Candidate,
  includeContent = true,
): PairEvidence | null {
  let best: PairEvidence | null = null;

  for (const member of candidate.articles) {
    const evidence = computePairEvidence(article, member, candidate.id, includeContent);

    if (!best) { best = evidence; continue; }

    // 决策优先级：exact > strong > ambiguous > reject
    const decisionRank: Record<string, number> = { exact: 3, strong: 2, ambiguous: 1, reject: 0 };
    const currentRank = decisionRank[evidence.decision] ?? 0;
    const bestRank = decisionRank[best.decision] ?? 0;

    if (currentRank > bestRank) { best = evidence; continue; }
    if (currentRank < bestRank) continue;

    // 同级时按分数排序
    const score = (e: PairEvidence) =>
      Number(e.fingerprintMatch) * 10
      + Number(e.eventKeyMatch) * 8
      + Number(e.exactTitle) * 6
      + e.identityScore * 5
      + e.titleOverlap * 2
      + Math.max(e.charContentOverlap, e.tokenContentOverlap) * 2
      + Math.max(e.charContentJaccard, e.tokenContentJaccard) * 1.5
      - Number(e.phaseConflict) * 4
      - Number(e.identityConflict) * 5
      - e.daysApart / EVENT_CLUSTER_WINDOW_DAYS * 2;

    if (score(evidence) > score(best)) best = evidence;
  }

  return best;
}

function isStrongPushedDuplicate(pair: PairEvidence): boolean {
  if (pair.fingerprintMatch) return true;
  if (pair.phaseConflict || pair.identityConflict) return false;
  if (pair.eventKeyMatch && pair.identityConfidence >= EVENT_CLUSTER_MIN_KEY_CONFIDENCE) return true;
  if (pair.identityScore >= 0.84
    && pair.subjectSimilarity >= 0.75
    && pair.actionSimilarity >= 0.6
    && pair.objectSimilarity >= 0.7) return true;
  // P0-3: 要求同一表示空间的指标同时成立
  const charConfirmed = pair.charContentOverlap >= 0.78 && pair.charContentJaccard >= 0.5;
  const tokenConfirmed = pair.tokenContentOverlap >= 0.78 && pair.tokenContentJaccard >= 0.5;
  return pair.sharedAnchors.length > 0
    && pair.titleOverlap >= 0.9
    && (charConfirmed || tokenConfirmed);
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
  signal?: AbortSignal,
) {
  const member = candidate.articles.find((item) => item.id === pair.matchedMemberArticleId) ?? candidate.articles[0];
  const prompt = `判断是否是同一个具体新闻事件。
同一事件必须同时满足：核心主体相同、具体动作/结果相同、时间阶段一致。
以下均不算同一事件：只有品牌/地点/奖项/话题相同；预告与事后结果；聚合快讯仅有一个子项重合。
证据不足时返回 false 且 confidence 不超过 60；只有存在明确冲突时才返回 false 且 confidence 至少 85。

新文章事件键：${article.eventKey}（置信度 ${article.eventKeyConfidence ?? 0}）
新文章：${article.title}
正文：${article.cleanContent.slice(0, 1_200)}

匹配成员事件键：${member.eventKey}（置信度 ${member.eventKeyConfidence ?? 0}）
匹配成员标题：${member.title}
匹配成员正文：${member.cleanContent.slice(0, 600)}

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
    const eventId = await db.$transaction((tx) => attachArticle(tx, article, exact.candidate, exact.evidence, 'exact', 100));
    await recalculateEventById(eventId);
    return { eventId, action: 'attach' };
  }

  const strong = ranked.find(({ evidence }) => evidence.decision === 'strong');
  if (strong) {
    const confidence = Math.min(99, Math.round(65
      + Number(strong.evidence.eventKeyMatch) * 20
      + strong.evidence.identityScore * 12
      + strong.evidence.titleOverlap * 6
      + Math.max(strong.evidence.charContentOverlap, strong.evidence.tokenContentOverlap) * 5));
    const eventId = await db.$transaction((tx) => attachArticle(tx, article, strong.candidate, strong.evidence, 'rule', confidence));
    await recalculateEventById(eventId);
    return { eventId, action: 'attach' };
  }

  const ambiguous = ranked
    .filter(({ evidence }) => evidence.decision === 'ambiguous')
    .slice(0, EVENT_CLUSTER_MAX_AI_CANDIDATES);

  const aiCandidates: AiCandidateAudit[] = [];
  for (const item of ambiguous) {
    let decision;
    try {
      decision = await askAiSameEvent(article, item.evidence, item.candidate, signal);
    } catch (error) {
      console.warn('[event-clustering] candidate decision failed:', error);
      aiCandidates.push({
        candidateEventId: item.candidate.id,
        matchedMemberArticleId: item.evidence.matchedMemberArticleId,
        ruleEvidence: item.evidence as unknown as Record<string, unknown>,
        aiDecision: { sameEvent: false, confidence: 0, reason: 'AI 判断失败，已保守分开' },
      });
      continue;
    }
    const auditDecision: AiCandidateAudit = {
      candidateEventId: item.candidate.id,
      matchedMemberArticleId: item.evidence.matchedMemberArticleId,
      ruleEvidence: item.evidence as unknown as Record<string, unknown>,
      aiDecision: {
        sameEvent: decision.same_event,
        confidence: decision.confidence,
        reason: decision.reason,
      },
    };
    aiCandidates.push(auditDecision);
    if (decision.same_event && decision.confidence >= 70) {
      const eventId = await db.$transaction((tx) => attachArticle(tx, article, item.candidate, item.evidence, 'ai', decision.confidence));
      await recalculateEventById(eventId);
      return { eventId, action: 'attach' };
    }
  }

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
