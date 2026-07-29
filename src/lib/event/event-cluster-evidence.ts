import {
  EVENT_CLUSTER_AUTO_MERGE_ANCHOR_DAYS,
  EVENT_CLUSTER_AUTO_MERGE_CONFIDENCE,
  EVENT_CLUSTER_AUTO_MERGE_IDENTITY_SCORE,
  EVENT_CLUSTER_AUTO_MERGE_OBJECT_SIMILARITY,
  EVENT_CLUSTER_AMBIGUOUS_TITLE_OVERLAP,
  EVENT_CLUSTER_FOLLOW_UP_DAYS,
  EVENT_CLUSTER_LOOSE_ANCHOR_COUNT,
  EVENT_CLUSTER_LOOSE_CONTENT_JACCARD,
  EVENT_CLUSTER_LOOSE_CONTENT_OVERLAP,
  EVENT_CLUSTER_LOOSE_OBJECT_SIMILARITY,
  EVENT_CLUSTER_LOOSE_TITLE_OVERLAP,
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

export interface RuleCandidateAudit {
  candidateEventId: string;
  matchedMemberArticleId: string;
  ruleEvidence: Record<string, unknown>;
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
    && evidence.identityConfidence >= EVENT_CLUSTER_AUTO_MERGE_CONFIDENCE
    && evidence.daysApart <= EVENT_CLUSTER_FOLLOW_UP_DAYS;
}

function isHighConfidenceIdentityMatch(evidence: {
  identityConfidence: number;
  identityScore: number;
  subjectSimilarity: number;
  actionSimilarity: number;
  objectSimilarity: number;
  daysApart: number;
  sharedAnchors: string[];
  tokenContentOverlap: number;
}): boolean {
  if (evidence.identityConfidence < EVENT_CLUSTER_AUTO_MERGE_CONFIDENCE
    || evidence.daysApart > EVENT_CLUSTER_FOLLOW_UP_DAYS) return false;

  const preciseIdentity = evidence.identityScore >= EVENT_CLUSTER_AUTO_MERGE_IDENTITY_SCORE
    && evidence.subjectSimilarity >= 0.8
    && evidence.actionSimilarity >= 0.8
    && evidence.objectSimilarity >= EVENT_CLUSTER_AUTO_MERGE_OBJECT_SIMILARITY;
  if (preciseIdentity) return true;

  // 事项写法可能一边是品牌/项目名、一边是通用描述。仅在主体和动作完全一致、
  // 同日附近且标题共享非泛化锚点时合并，避免把同品牌不同新品混成一个事件。
  return evidence.subjectSimilarity >= 0.9
    && evidence.actionSimilarity >= 0.9
    && evidence.objectSimilarity >= 0.2
    && evidence.daysApart <= EVENT_CLUSTER_AUTO_MERGE_ANCHOR_DAYS
    && evidence.sharedAnchors.length > 0
    && evidence.tokenContentOverlap >= 0.3;
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

export function buildRuleCandidateAuditEvidence(candidates: RuleCandidateAudit[], selectedCandidateEventId: string | null) {
  return { selectedCandidateEventId, candidates: [...candidates] };
}

/**
 * 仅决定是否把“相近但未合并”的候选写入审计，绝不影响自动归并或人工复核。
 * 这样运营人员能看到系统曾比较过什么，同时证据不足的文章仍直接独立建 Event。
 */
function isAuditableNearbyCandidate(evidence: {
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
  if (evidence.daysApart > EVENT_CLUSTER_FOLLOW_UP_DAYS) return false;

  const identitySignal = evidence.identityConfidence >= EVENT_CLUSTER_MIN_KEY_CONFIDENCE
    && evidence.subjectSimilarity >= 0.5
    && (evidence.actionSimilarity >= 0.4 || evidence.objectSimilarity >= 0.5);
  const titleSignal = evidence.sharedAnchors.length > 0
    && evidence.titleOverlap >= EVENT_CLUSTER_AMBIGUOUS_TITLE_OVERLAP
    && evidence.daysApart <= EVENT_CLUSTER_WINDOW_DAYS
    && evidence.identityScore >= 0.35;
  const charContentSignal = evidence.charContentOverlap >= 0.45
    && evidence.charContentJaccard >= 0.25;
  const tokenContentSignal = evidence.tokenContentOverlap >= 0.45
    && evidence.tokenContentJaccard >= 0.25;
  const contentSignal = (charContentSignal || tokenContentSignal)
    && evidence.subjectSimilarity >= 0.5
    && (evidence.actionSimilarity >= 0.4 || evidence.objectSimilarity >= 0.5);

  return (evidence.eventKeyMatch && evidence.identityConfidence >= EVENT_CLUSTER_MIN_KEY_CONFIDENCE)
    || identitySignal
    || titleSignal
    || contentSignal;
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
  const identityConfidence = Math.min(
    left.eventKeyConfidence ?? 0,
    right.eventKeyConfidence ?? 0,
  );
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

function isLooseSameEventMatch(evidence: {
  daysApart: number;
  phaseConflict: boolean;
  qualifierConflict: boolean;
  qualifierConflictOnPair: boolean;
  sharedAnchors: string[];
  objectAnchors: string[];
  subjectSimilarity: number;
  objectSimilarity: number;
  titleOverlap: number;
  charContentOverlap: number;
  charContentJaccard: number;
  tokenContentOverlap: number;
  tokenContentJaccard: number;
}): boolean {
  if (evidence.daysApart > EVENT_CLUSTER_FOLLOW_UP_DAYS
    || evidence.phaseConflict
    || evidence.qualifierConflict
    || evidence.qualifierConflictOnPair) return false;

  const titleAnchorsMatch = evidence.sharedAnchors.length >= EVENT_CLUSTER_LOOSE_ANCHOR_COUNT
    && evidence.titleOverlap >= EVENT_CLUSTER_LOOSE_TITLE_OVERLAP
    && (evidence.objectAnchors.length > 0 || evidence.objectSimilarity >= EVENT_CLUSTER_LOOSE_OBJECT_SIMILARITY);
  const subjectTitleMatch = evidence.subjectSimilarity >= 0.65
    && evidence.sharedAnchors.length > 0
    && evidence.titleOverlap >= EVENT_CLUSTER_LOOSE_TITLE_OVERLAP
    && (evidence.objectAnchors.length > 0 || evidence.objectSimilarity >= EVENT_CLUSTER_LOOSE_OBJECT_SIMILARITY);
  const contentMatch = (evidence.sharedAnchors.length > 0 || evidence.titleOverlap >= 0.3)
    && (evidence.objectAnchors.length > 0 || evidence.objectSimilarity >= EVENT_CLUSTER_LOOSE_OBJECT_SIMILARITY)
    && (
      evidence.charContentOverlap >= EVENT_CLUSTER_LOOSE_CONTENT_OVERLAP
      && evidence.charContentJaccard >= EVENT_CLUSTER_LOOSE_CONTENT_JACCARD
      || evidence.tokenContentOverlap >= EVENT_CLUSTER_LOOSE_CONTENT_OVERLAP
      && evidence.tokenContentJaccard >= EVENT_CLUSTER_LOOSE_CONTENT_JACCARD
    );

  return titleAnchorsMatch || subjectTitleMatch || contentMatch;
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
  const sharedAnchors = sharedEventAnchors(article.title, member.title);
  const objectAnchors = sharedEventAnchors(article.eventObject, member.eventObject);

  let contentSimilarity: ContentShingleResult = {
    charOverlap: 0, charJaccard: 0, tokenOverlap: 0, tokenJaccard: 0,
  };
  if (includeContent) {
    const sameSubject = identity.subjectOverlap >= 0.5;
    const sameExactTitle = normalizedTitle.length > 0 && normalizedTitle === memberNormalizedTitle;
    // AI 主体可能因改写而不稳定；只要标题有稳定锚点，也允许正文证据参与。
    // 仍不对所有候选计算正文，避免同站点模板文案放大误合并。
    if (fingerprintMatch || sameSubject || sameExactTitle || sharedAnchors.length > 0) {
      contentSimilarity = contentShingleSimilarity(article.cleanContent, member.cleanContent);
    }
  }

  const daysApart = Math.abs(articleDate(article).getTime() - articleDate(member).getTime()) / 86_400_000;

  const phaseConflict = hasEventPhaseConflict(
    `${article.title} ${article.eventAction} ${article.eventObject}`,
    `${member.title} ${member.eventAction} ${member.eventObject}`,
  );

  const multiTopic = isMultiTopicTitle(article.title) || isMultiTopicTitle(member.title);

  const qualifierConflictOnPair = hasEventIdentityQualifierConflict(
    article.eventObject, member.eventObject,
  );

  // P0-2: 每个 pair 独立决策
  let decision: PairEvidence['decision'] = 'reject';

  const isExact = fingerprintMatch || (
    exactTitle
    && daysApart <= EVENT_CLUSTER_FOLLOW_UP_DAYS
    && !phaseConflict
    && !identity.identityConflict
    && (eventKeyMatch || identity.identityScore >= EVENT_CLUSTER_STRONG_IDENTITY_SCORE)
  );
  if (isExact) {
    decision = 'exact';
  } else if (!multiTopic) {
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
    const identityConfirmed = isHighConfidenceIdentityMatch({
      identityConfidence: identity.identityConfidence,
      identityScore: identity.identityScore,
      subjectSimilarity: identity.subjectOverlap,
      actionSimilarity: identity.actionOverlap,
      objectSimilarity: identity.objectOverlap,
      daysApart,
      sharedAnchors,
      tokenContentOverlap: contentSimilarity.tokenOverlap,
    }) || (
      identity.identityConfidence >= EVENT_CLUSTER_MIN_KEY_CONFIDENCE
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
      })
    );
    const titleConfirmed = sharedAnchors.length > 0
      && titleOverlap >= EVENT_CLUSTER_STRONG_TITLE_OVERLAP
      && daysApart <= EVENT_CLUSTER_STRONG_TITLE_DAYS
      && identity.identityScore >= 0.6
      && identity.actionOverlap >= 0.45
      && identity.objectOverlap >= 0.65;

    // 正文高度相似本身不足以证明同一事件：同品牌页面常有相同模板、简介或背景。
    // 它只能作为 nearExactReprint 或 identityConfirmed 的补强证据，不能单独自动归并。
    const standardRuleMatch = !phaseConflict && !identity.identityConflict
      && (nearExactReprint || keyConfirmed || identityConfirmed || titleConfirmed);
    const looseRuleMatch = isLooseSameEventMatch({
      daysApart,
      phaseConflict,
      qualifierConflict: identity.qualifierConflict,
      qualifierConflictOnPair,
      sharedAnchors,
      objectAnchors,
      subjectSimilarity: identity.subjectOverlap,
      objectSimilarity: identity.objectOverlap,
      titleOverlap,
      charContentOverlap: contentSimilarity.charOverlap,
      charContentJaccard: contentSimilarity.charJaccard,
      tokenContentOverlap: contentSimilarity.tokenOverlap,
      tokenContentJaccard: contentSimilarity.tokenJaccard,
    });
    if (standardRuleMatch || looseRuleMatch) {
      decision = 'strong';
    } else if (isAuditableNearbyCandidate({
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
  if (isHighConfidenceIdentityMatch(pair)) return true;
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
