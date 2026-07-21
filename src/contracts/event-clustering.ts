export const EVENT_CLUSTER_WINDOW_DAYS = 7;
// 候选召回优先保证覆盖率，最终只把少量高相关候选交给 AI。
export const EVENT_CLUSTER_CONTENT_RECALL_CANDIDATES = 48;
export const EVENT_CLUSTER_MAX_CANDIDATES = 15;
export const EVENT_CLUSTER_MAX_AI_CANDIDATES = 5;
export const EVENT_CLUSTER_MAX_MEMBER_ARTICLES = 12;
export const EVENT_CLUSTER_MAX_RETRIES = 5;
export const EVENT_CLUSTER_RULE_VERSION = 'event-cluster-v6';

export interface ContentShingleResult {
  charOverlap: number;
  charJaccard: number;
  tokenOverlap: number;
  tokenJaccard: number;
}

export function contentShingleSimilarity(
  left: string,
  right: string,
  size = 8,
  maxChars = 6_000,
): ContentShingleResult {
  const a = buildCharacterNgrams(left.slice(0, maxChars), [size]);
  const b = buildCharacterNgrams(right.slice(0, maxChars), [size]);
  const charResult = a.size === 0 || b.size === 0
    ? { overlap: 0, jaccard: 0 }
    : (() => {
        let intersection = 0;
        for (const gram of a) if (b.has(gram)) intersection++;
        return {
          overlap: intersection / Math.min(a.size, b.size),
          jaccard: intersection / (a.size + b.size - intersection),
        };
      })();

  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  const buildTokens = (value: string) => new Set(
    [...segmenter.segment(value.slice(0, maxChars))]
      .filter((part) => part.isWordLike)
      .map((part) => normalizeEventText(part.segment))
      .filter((token) => token.length >= 2),
  );
  const leftTokens = buildTokens(left);
  const rightTokens = buildTokens(right);
  const tokenResult = leftTokens.size === 0 || rightTokens.size === 0
    ? { overlap: 0, jaccard: 0 }
    : (() => {
        let intersection = 0;
        for (const token of leftTokens) if (rightTokens.has(token)) intersection++;
        return {
          overlap: intersection / Math.min(leftTokens.size, rightTokens.size),
          jaccard: intersection / (leftTokens.size + rightTokens.size - intersection),
        };
      })();

  return {
    charOverlap: charResult.overlap,
    charJaccard: charResult.jaccard,
    tokenOverlap: tokenResult.overlap,
    tokenJaccard: tokenResult.jaccard,
  };
}
export const EVENT_CLUSTER_STRONG_TITLE_OVERLAP = 0.66;
export const EVENT_CLUSTER_STRONG_TITLE_DAYS = 2;
export const EVENT_CLUSTER_STRONG_CONTENT_OVERLAP = 0.72;
export const EVENT_CLUSTER_STRONG_CONTENT_JACCARD = 0.45;
export const EVENT_CLUSTER_AMBIGUOUS_TITLE_OVERLAP = 0.55;
export const EVENT_CLUSTER_AMBIGUOUS_CONTENT_OVERLAP = 0.35;
export const EVENT_CLUSTER_AMBIGUOUS_CONTENT_JACCARD = 0.2;
export const EVENT_CLUSTER_MIN_KEY_CONFIDENCE = 65;
export const EVENT_CLUSTER_STRONG_IDENTITY_SCORE = 0.72;
export const EVENT_CLUSTER_AMBIGUOUS_IDENTITY_SCORE = 0.55;
export const EVENT_CLUSTER_ANCHOR_MIN_LENGTH = 2;

export type ClusterStatus = 'pending' | 'clustered' | 'failed' | 'needs_review';

export function normalizeEventText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

export function buildCharacterNgrams(value: string, sizes: readonly number[] = [2, 3, 4]): Set<string> {
  const normalized = normalizeEventText(value);
  const grams = new Set<string>();
  for (const size of sizes) {
    for (let index = 0; index + size <= normalized.length; index++) {
      grams.add(normalized.slice(index, index + size));
    }
  }
  return grams;
}

export function overlapCoefficient(left: string, right: string): number {
  let best = 0;
  for (const size of [2, 3, 4] as const) {
    const a = buildCharacterNgrams(left, [size]);
    const b = buildCharacterNgrams(right, [size]);
    if (a.size === 0 || b.size === 0) continue;
    let intersection = 0;
    for (const gram of a) if (b.has(gram)) intersection++;
    best = Math.max(best, intersection / Math.min(a.size, b.size));
  }
  return best;
}

export function hasLiteralContentOverlap(left: string, right: string, size = 12): boolean {
  const a = normalizeEventText(left).slice(0, 6_000);
  const b = normalizeEventText(right).slice(0, 6_000);
  if (a.length < size || b.length < size) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  for (let index = 0; index + size <= shorter.length; index += 4) {
    if (longer.includes(shorter.slice(index, index + size))) return true;
  }
  return false;
}

export function isMultiTopicTitle(value: string): boolean {
  const clauses = value
    .split(/[；;！？!?]+/u)
    .map((item) => item.trim())
    .filter((item) => normalizeEventText(item).length >= 6);
  if (clauses.length < 2) return false;
  if (/^(?:联商头条|联商快讯|行业快讯|今日快讯|早报|晚报|周报|一周要闻)/u.test(value.trim())) return true;

  const actionPattern = /(?:计划|即将|开卖|推出|投运|开仓|开业|闭店|停业|撤场|入股|收购|并购|融资|上市|签约|合作|发布|上线|下架|涨价|降价|裁员|换帅|任命|离职|捐赠|驰援|落地|启幕|获奖|荣获|扩店|关店|关停|进军|入局)/u;
  const subjects = clauses.map((clause) => {
    const normalized = normalizeEventText(clause);
    const match = normalized.match(new RegExp(`^(.{2,24}?)${actionPattern.source}`, 'u'));
    if (!match) return '';
    const subject = match[1].replace(/^(?:当|为何|为什么|如何|再|加码|发力|传|网传)/u, '');
    return subject.length >= 2 ? subject : '';
  }).filter(Boolean);
  return new Set(subjects).size >= 2;
}

const EVENT_GENERIC_TOKENS = new Set([
  '品牌', '战略', '合作', '首次', '中国', '探索', '模型', '首店', '落地', '正式', '亮相',
  '启幕', '开业', '发布', '增长', '荣获', '年度', '门店', '超市', '便利', '百货', '项目',
]);

export function buildEventAnchorTokens(value: string): Set<string> {
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  const tokens = new Set<string>();
  for (const part of segmenter.segment(value.normalize('NFKC').toLowerCase())) {
    if (!part.isWordLike) continue;
    const token = normalizeEventText(part.segment);
    if (token.length < EVENT_CLUSTER_ANCHOR_MIN_LENGTH || EVENT_GENERIC_TOKENS.has(token) || /^\d+$/u.test(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

export function sharedEventAnchors(left: string, right: string): string[] {
  const a = buildEventAnchorTokens(left);
  const b = buildEventAnchorTokens(right);
  return [...a].filter((token) => b.has(token));
}

function eventQualifiers(value: string): Map<string, Set<string>> {
  const normalized = value.normalize('NFKC').toLowerCase();
  const result = new Map<string, Set<string>>();
  const add = (kind: string, token: string) => {
    const values = result.get(kind) ?? new Set<string>();
    values.add(token);
    result.set(kind, values);
  };
  for (const match of normalized.matchAll(/20\d{2}/gu)) add('year', match[0]);
  const quarterMap: Record<string, string> = { 一: '1', 二: '2', 三: '3', 四: '4' };
  for (const match of normalized.matchAll(/q([1-4])|第?([一二三四1-4])季度/gu)) {
    const quarter = match[1] ?? match[2];
    if (quarter) add('quarter', quarterMap[quarter] ?? quarter);
  }
  for (const match of normalized.matchAll(/第([一二三四五六七八九十\d]+)(期|届|批)/gu)) {
    if (match[1] && match[2]) add(match[2], match[1]);
  }
  return result;
}

export function hasEventIdentityQualifierConflict(left: string, right: string): boolean {
  const leftQualifiers = eventQualifiers(left);
  const rightQualifiers = eventQualifiers(right);
  for (const kind of ['year', 'quarter', '期', '届', '批']) {
    const leftValues = leftQualifiers.get(kind);
    const rightValues = rightQualifiers.get(kind);
    if (!leftValues?.size || !rightValues?.size) continue;
    if (![...leftValues].some((value) => rightValues.has(value))) return true;
  }
  return false;
}

const FUTURE_PHASE_PATTERN = /即将|将于|将在|拟|计划|预计|筹备|待开|有望/u;
const REALIZED_PHASE_PATTERN = /正式|已经|已|落地|亮相|开业|启幕|首日|增长|完成|投运|开仓|撤场|摘牌|获批|签约/u;

export function hasEventPhaseConflict(left: string, right: string): boolean {
  const leftFuture = FUTURE_PHASE_PATTERN.test(left);
  const rightFuture = FUTURE_PHASE_PATTERN.test(right);
  const leftRealized = REALIZED_PHASE_PATTERN.test(left);
  const rightRealized = REALIZED_PHASE_PATTERN.test(right);
  return (leftFuture && rightRealized && !rightFuture) || (rightFuture && leftRealized && !leftFuture);
}
