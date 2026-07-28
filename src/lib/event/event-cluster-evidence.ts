import {
  EVENT_CLUSTER_AMBIGUOUS_CONTENT_OVERLAP,
  EVENT_CLUSTER_AMBIGUOUS_CONTENT_JACCARD,
  EVENT_CLUSTER_AMBIGUOUS_IDENTITY_SCORE,
  EVENT_CLUSTER_AMBIGUOUS_TITLE_OVERLAP,
  DEFAULT_EVENT_CLUSTER_AI_DIFFERENT_EVENT_CONFIDENCE,
  EVENT_CLUSTER_MIN_KEY_CONFIDENCE,
  EVENT_CLUSTER_STRONG_CONTENT_JACCARD,
  EVENT_CLUSTER_STRONG_CONTENT_OVERLAP,
  EVENT_CLUSTER_STRONG_IDENTITY_SCORE,
  EVENT_CLUSTER_STRONG_TITLE_DAYS,
  EVENT_CLUSTER_STRONG_TITLE_OVERLAP,
  EVENT_CLUSTER_WINDOW_DAYS,
  contentShingleSimilarity,
  hasEventIdentityQualifierConflict,
  hasEventPhaseConflict,
  isMultiTopicTitle,
  normalizeEventText,
  overlapCoefficient,
  sharedEventAnchors,
  type ContentShingleResult,
} from '@/contracts/event-clustering';
import { parseEventSubjects } from '@/contracts/event-identity';

export type Candidate = {
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

export const candidateArticleSelect = {
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
  // 正文相似只能证明“稿件内容接近”，不能证明“事件相同”。至少要求主体
  // 与动作/具体事项共同一致，避免不同品牌使用同一站点模板时进入人工复核。
  const contentIdentitySignal = evidence.actionSimilarity >= 0.4
    || evidence.objectSimilarity >= 0.5;
  const contentSignal = (charContentSignal || tokenContentSignal)
    && contentIdentitySignal
    && (evidence.subjectSimilarity >= 0.5 || evidence.identityScore >= 0.55)
    && (evidence.sharedAnchors.length > 0 || evidence.identityScore >= 0.4);

  return keySignal || identitySignal || titleSignal || contentSignal;
}

export function hasDuplicateReportEvidence(evidence: {
  titleOverlap: number;
  charContentOverlap: number;
  charContentJaccard: number;
  tokenContentOverlap: number;
  tokenContentJaccard: number;
}): boolean {
  const titleWithContent = evidence.titleOverlap >= EVENT_CLUSTER_AMBIGUOUS_TITLE_OVERLAP
    && (evidence.charContentOverlap >= 0.2 || evidence.tokenContentOverlap >= 0.3);
  const charContent = evidence.charContentOverlap >= EVENT_CLUSTER_STRONG_CONTENT_OVERLAP
    && evidence.charContentJaccard >= EVENT_CLUSTER_STRONG_CONTENT_JACCARD;
  const tokenContent = evidence.tokenContentOverlap >= EVENT_CLUSTER_STRONG_CONTENT_OVERLAP
    && evidence.tokenContentJaccard >= 0.15;
  return titleWithContent || charContent || tokenContent;
}

export function isStrongEventKeyDuplicate(evidence: {
  eventKeyMatch: boolean;
  identityConfidence: number;
  daysApart: number;
  titleOverlap: number;
  charContentOverlap: number;
  charContentJaccard: number;
  tokenContentOverlap: number;
  tokenContentJaccard: number;
}): boolean {
  return evidence.eventKeyMatch
    && evidence.identityConfidence >= EVENT_CLUSTER_MIN_KEY_CONFIDENCE
    && hasDuplicateReportEvidence(evidence);
}

export function isNearExactReprint(evidence: {
  exactTitle: boolean;
  tokenContentOverlap: number;
  tokenContentJaccard: number;
  phaseConflict: boolean;
  identityConflict: boolean;
  multiTopic: boolean;
}): boolean {
  return evidence.exactTitle
    && evidence.tokenContentOverlap >= 0.95
    && evidence.tokenContentJaccard >= 0.8
    && !evidence.phaseConflict
    && !evidence.identityConflict
    && !evidence.multiTopic;
}

export function shouldCreateClusterReview(
  ambiguousCount: number,
  aiCandidates: Pick<AiCandidateAudit, 'aiDecision'>[],
  differentEventConfidence = DEFAULT_EVENT_CLUSTER_AI_DIFFERENT_EVENT_CONFIDENCE,
): boolean {
  if (ambiguousCount === 0) return false;
  const hasAiFailure = aiCandidates.some((candidate) => candidate.aiDecision.confidence === 0);
  const allAmbiguousConfidentlyDifferent = aiCandidates.length === ambiguousCount
    && aiCandidates.every((candidate) => (
      !candidate.aiDecision.sameEvent && candidate.aiDecision.confidence >= differentEventConfidence
    ));
  return hasAiFailure || !allAmbiguousConfidentlyDifferent;
}

export function buildAiClusterAuditEvidence(candidates: AiCandidateAudit[], selectedCandidateEventId: string | null) {
  return { selectedCandidateEventId, candidates: [...candidates] };
}

export function articleDate(article: { publishedAt: Date | null; createdAt: Date }): Date {
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
  const leftConf = left.eventKeyConfidence;
  const rightConf = right.eventKeyConfidence;
  const identityConfidence = leftConf != null && rightConf != null
    ? Math.min(leftConf, rightConf)
    : leftConf ?? rightConf ?? 0;
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
    const sameSubject = identity.subjectOverlap >= 0.5;
    const sameExactTitle = normalizedTitle.length > 0 && normalizedTitle === memberNormalizedTitle;
    // 正文相似度只有在主体或标题已有交集时才值得计算。不同品牌在同一站点
    // 常共享页脚、推荐栏和模板文案，直接比较会制造大量伪“强重复”。
    if (fingerprintMatch || sameSubject || sameExactTitle) {
      contentSimilarity = contentShingleSimilarity(article.cleanContent, member.cleanContent);
    }
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
    // 不同媒体转载时常只删改署名、图片说明或个别句子。标题完全一致且正文
    // token 几乎重合时，这是比单次 AI 事件身份更稳定的“同一稿件”证据。
    const nearExactReprint = isNearExactReprint({
      exactTitle,
      tokenContentOverlap: contentSimilarity.tokenOverlap,
      tokenContentJaccard: contentSimilarity.tokenJaccard,
      phaseConflict,
      identityConflict: identity.identityConflict,
      multiTopic,
    });
    const keyConfirmed = isStrongEventKeyDuplicate({
      eventKeyMatch,
      identityConfidence: identity.identityConfidence,
      daysApart,
      titleOverlap,
      charContentOverlap: contentSimilarity.charOverlap,
      charContentJaccard: contentSimilarity.charJaccard,
      tokenContentOverlap: contentSimilarity.tokenOverlap,
      tokenContentJaccard: contentSimilarity.tokenJaccard,
    });
    const identityConfirmed = identity.identityConfidence >= EVENT_CLUSTER_MIN_KEY_CONFIDENCE
      && identity.identityScore >= EVENT_CLUSTER_STRONG_IDENTITY_SCORE
      && identity.subjectOverlap >= 0.6
      && identity.actionOverlap >= 0.5
      && identity.objectOverlap >= 0.45
      && hasDuplicateReportEvidence({
        titleOverlap,
        charContentOverlap: contentSimilarity.charOverlap,
        charContentJaccard: contentSimilarity.charJaccard,
        tokenContentOverlap: contentSimilarity.tokenOverlap,
        tokenContentJaccard: contentSimilarity.tokenJaccard,
      });
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

    if (nearExactReprint || keyConfirmed || identityConfirmed || charContentConfirmed || tokenContentConfirmed || titleConfirmed) {
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
export function bestPairEvidenceForCandidate(
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

export function isStrongPushedDuplicate(pair: PairEvidence): boolean {
  if (pair.fingerprintMatch) return true;
  if (pair.phaseConflict || pair.identityConflict) return false;
  if (isStrongEventKeyDuplicate(pair)) return true;
  if (pair.identityScore >= 0.84
    && pair.subjectSimilarity >= 0.75
    && pair.actionSimilarity >= 0.6
    && pair.objectSimilarity >= 0.7
    && hasDuplicateReportEvidence(pair)) return true;
  // P0-3: 要求同一表示空间的指标同时成立
  const charConfirmed = pair.charContentOverlap >= 0.78 && pair.charContentJaccard >= 0.5;
  const tokenConfirmed = pair.tokenContentOverlap >= 0.78 && pair.tokenContentJaccard >= 0.5;
  return pair.sharedAnchors.length > 0
    && pair.titleOverlap >= 0.9
    && (charConfirmed || tokenConfirmed);
}
