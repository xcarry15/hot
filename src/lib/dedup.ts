/**
 * Deduplication — first-principles design.
 *
 * 去重的本质：判断两篇文章是否报道同一事件。只保留高置信信号，
 * 删除假阳性高 / 冗余的信号。
 *
 * 保留信号（按置信度）：
 *   1. URL 精确            — DB unique constraint（crawler 层，不在本文件）
 *   2. 内容指纹 SHA-256    — 完全相同内容转载（采集时）
 *   3. 数值重叠 ≥ N        — 同一事件的特定数据点共享（行业新闻最强信号）
 *   4. 正文 LCS ≥ 阈值     — 大段原文照搬（通稿 / 转载带改动）
 *   5. 标题 Jaccard          — 仅作为证据展示，不单独触发删除
 *
 * 已删除的弱 / 冗余信号：
 *   - SimHash on title      — 与 Jaccard / LCS 冗余，中文短标题区分度差
 *   - 加权融合分数          — 弱信号线性叠加不会变强
 *   - 命名实体重叠作独立信号 — eventKeys 是高频行业词，假阳性高
 *   - LCS isPrefixOnly 交叉规则 — 不再作为独立标题规则
 *
 * 阶段（7 道闸门 → 3 道闸门）：
 *   A. 采集时 findDuplicateArticle  — URL + fingerprint + body LCS（标题仅辅助证据）
 *   B. AI 前 dedupBeforeAI          — 合并 L3(pending↔pending) + P0(pending↔done)，numeric + body LCS
 *   C. AI 后 dedupAfterAI           — per-article，brand gate + keyPoints numeric + keyPoints LCS
 *      + dedupAfterAiBatch          — batch 内成对互查（兜底并发漏判）
 *
 * 所有阶段共用 dedup window（按 publishedAt，回退 createdAt）。
 * 阈值由用户在「设置 → 推送 → 去重规则」配置；详见 DEDUP_LIMITS。
 */

import { db } from './db';
import { getDedupConfig, type DedupConfig } from './dedup-config';
import {
  extractNumericValues,
  getSharedNumericValues,
  isDistinctiveNumericValue,
} from './dedup-numeric';
import {
  DAY_MS,
  DEDUP_CANDIDATE_CAP,
  DEDUP_DONE_CAP,
  dedupWindowWhere,
  effectiveArticleTime,
  formatSharedValuesStr,
} from './dedup-shared';
import {
  buildLcsSnippets,
  buildNumericSnippets,
  buildTitleSnippet,
  computeContentFingerprint,
  getBigrams,
  jaccardSimilarity,
  sameDay,
  stripLen,
  stripWs,
  totalLcsRunLength,
} from './dedup-text';
import type { DedupEvidence, DedupSnippet } from './dedup-evidence';
export { DEDUP_LIMITS, getDedupConfig, _invalidateDedupConfig } from './dedup-config';
export { countSharedNumericValues, extractNumericValues } from './dedup-numeric';
export { dedupAfterAI, dedupAfterAiBatch, isSameEventByKeyPointsForTest } from './dedup-keypoints';
export type { KeyPointsDuplicateResult, KeyPointsView } from './dedup-keypoints';
export { computeContentFingerprint, longestCommonSubstring } from './dedup-text';

/** 多段 LCS 总长（导出供测试）。返回 ≥ minRun 的公共串长度累加。 */
export const totalLcsRunLengthForTest = totalLcsRunLength;

/** 导出供测试：内容对比片段构建。 */
export const buildLcsSnippetsForTest = buildLcsSnippets;
export const buildNumericSnippetsForTest = buildNumericSnippets;

// ---------------------------------------------------------------------------
// Shared pair-check primitives
// ---------------------------------------------------------------------------

/**
 * AI 前正文同事件判定（无 brand，pending↔pending / pending↔done 共用）。
 *
 * 信号（按强度从高到低）：
 *   1. 数值重叠 ≥ numericSharedMin + 正文 LCS     → 判同（数字不能单独作为事件指纹）
 *   2. 数值重叠 ≥ 1 + 同日 + 正文多段 LCS 总长 ≥ lcsTotalMin → borderline 用多段 LCS 确认
 *   3. 无数值重叠 + 两篇短文(≤shortBodyThreshold) + 正文多段 LCS 总长 ≥ lcsTotalMin → 短文 LCS 兜底
 *
 * 多段 LCS 总长（替代单段 LCS）：见 totalLcsRunLength。要求至少 N 字符的总公共串才判重，
 * 滤掉单段巧合（样板 / 引用 / 数据列表）。
 */
interface ArticleBodyView {
  id: string;
  cleanContent: string;
  publishedAt: Date | null;
  createdAt?: Date | null;
}

function sameEffectiveDay(a: ArticleBodyView, b: ArticleBodyView): boolean {
  return sameDay(a.publishedAt ?? a.createdAt ?? null, b.publishedAt ?? b.createdAt ?? null);
}

function isSameEventByBodyInternal(
  a: ArticleBodyView,
  b: ArticleBodyView,
  numsA: Set<string>,
  numsB: Set<string>,
  cfg: DedupConfig,
): boolean {
  return checkBodyDup(a, b, numsA, numsB, cfg).isDuplicate;
}

/**
 * 同 isSameEventByBodyInternal，但返回触发信号（供 dedupBeforeAI 构造 DedupEvidence）。
 * signal 取值：'numeric'（≥numericSharedMin）/ 'numeric_lcs'（borderline：1值+同日+LCS）
 *              / 'body_lcs'（短文 LCS 兜底）/ null（未判重）。
 */
type BodySignal = 'numeric' | 'numeric_lcs' | 'body_lcs' | null;

function checkBodyDup(
  a: ArticleBodyView,
  b: ArticleBodyView,
  numsA: Set<string>,
  numsB: Set<string>,
  cfg: DedupConfig,
): { isDuplicate: boolean; signal: BodySignal } {
  let shared = 0;
  if (numsA.size > 0 && numsB.size > 0) {
    const [smaller, larger] = numsA.size < numsB.size ? [numsA, numsB] : [numsB, numsA];
    for (const v of smaller) if (larger.has(v)) shared++;
  }

  const sharedValues = getSharedNumericValues(
    numsA.size < numsB.size ? numsA : numsB,
    numsA.size < numsB.size ? numsB : numsA,
  ).values;
  const distinctiveSharedCount = sharedValues.filter(isDistinctiveNumericValue).length;

  // 第 1 道闸：数值只能召回候选，还必须由正文连续语义重叠确认。
  // 不同事件经常共享“100家/3000家”等数字，单独自动跳过会产生不可恢复的误杀。
  if (shared >= cfg.numericSharedMin && distinctiveSharedCount >= 1) {
    const total = totalLcsRunLength(
      stripWs(a.cleanContent),
      stripWs(b.cleanContent),
      cfg.bodyLcsMin,
    );
    if (total >= cfg.lcsTotalMin) return { isDuplicate: true, signal: 'numeric' };
  }

  // 第 2 道闸：borderline — 1 共享值 + 同日 + 多段 LCS 总长确认
  if (distinctiveSharedCount >= 1 && sameEffectiveDay(a, b)) {
    const total = totalLcsRunLength(
      stripWs(a.cleanContent),
      stripWs(b.cleanContent),
      cfg.bodyLcsMin,    // 单段 ≥ bodyLcsMin 才算一段
    );
    if (total >= cfg.lcsTotalMin) return { isDuplicate: true, signal: 'numeric_lcs' };
  }

  // 第 3 道闸：短文 LCS 兜底（无数值场景）
  const aShort = stripLen(a.cleanContent) <= cfg.shortBodyThreshold;
  const bShort = stripLen(b.cleanContent) <= cfg.shortBodyThreshold;
  if (aShort && bShort) {
    const total = totalLcsRunLength(
      stripWs(a.cleanContent),
      stripWs(b.cleanContent),
      cfg.bodyLcsMin,
      cfg.shortBodyThreshold, // 短文 maxLen 也用 shortBodyThreshold
    );
    if (total >= cfg.lcsTotalMin) return { isDuplicate: true, signal: 'body_lcs' };
  }

  return { isDuplicate: false, signal: null };
}

// ---------------------------------------------------------------------------
// 采集时去重 — findDuplicateArticle
// ---------------------------------------------------------------------------

interface NearDuplicateResult {
  isDuplicate: boolean;
  dedupType: 'content_fingerprint' | 'near_duplicate' | null;
  similarity: number;
  matchedId?: string;
  matchedUrl?: string;
  matchedTitle?: string;
  matchedPublishedAt?: Date | null;
  /** 触发信号（供 findDuplicateArticle 构造 DedupEvidence）：fingerprint / title_jaccard / body_lcs / null */
  signal?: 'fingerprint' | 'title_jaccard' | 'body_lcs' | null;
  /** 标题 Jaccard 相似度（无论是否触发，都带回供 evidence 用） */
  titleSim?: number;
  /** 正文多段 LCS 总长（触发 body_lcs 时带回） */
  lcsTotal?: number;
  /** 规范化去重证据（命中时由 findDuplicateArticle 构造，crawler 写入 discarded.detail） */
  evidence?: DedupEvidence;
}

/**
 * 采集时近重复判定（标题 + 列表页摘要/部分正文）。
 *
 * 信号（按强度从高到低）：
 *   1. fingerprint 完全相同                            → 整篇转载
 *   2. 正文多段 LCS 总长 ≥ lcsTotalMin（需足够正文）    → 通稿 / 转载带改动
 *
 * 标题相似度只作为返回值中的辅助信息，不再单独触发自动删除。
 * 新闻标题模板高度重复，标题相似不是“同一事件”的充分条件。
 */
function isNearDuplicateInternal(
  titleA: string,
  contentA: string,
  titleB: string,
  contentB: string,
  cfg: DedupConfig,
  existingFingerprintB?: string,
  incomingBigrams?: Set<string>,
  existingFingerprintA?: string,
): NearDuplicateResult {
  const fingerprintA = existingFingerprintA || computeContentFingerprint(titleA, contentA);
  const fingerprintB = existingFingerprintB || computeContentFingerprint(titleB, contentB);
  if (fingerprintA === fingerprintB) {
    return { isDuplicate: true, dedupType: 'content_fingerprint', similarity: 1.0, signal: 'fingerprint' };
  }

  // 复用调用方预算好的 bigrams（findDuplicateArticle N² 循环里同一 titleA 复用 N 次）
  const titleSim = jaccardSimilarity(titleA, titleB, incomingBigrams);
  const hasEnoughContent =
    contentA && contentB &&
    stripLen(contentA) >= 200 && stripLen(contentB) >= 200;
  if (hasEnoughContent) {
    const total = totalLcsRunLength(
      stripWs(contentA),
      stripWs(contentB),
      cfg.bodyLcsMin,
    );
    if (total >= cfg.lcsTotalMin) {
      return { isDuplicate: true, dedupType: 'near_duplicate', similarity: Math.max(titleSim, 0.55), signal: 'body_lcs', titleSim, lcsTotal: total };
    }
  }

  return { isDuplicate: false, dedupType: null, similarity: titleSim, signal: null, titleSim };
}

/** 导出供测试：采集时近重复判定 */
export function isNearDuplicateForTest(
  titleA: string,
  contentA: string,
  titleB: string,
  contentB: string,
  cfg: DedupConfig,
  existingFingerprintB?: string,
): NearDuplicateResult {
  return isNearDuplicateInternal(titleA, contentA, titleB, contentB, cfg, existingFingerprintB);
}

/**
 * 由采集时近重复判定结果构造 DedupEvidence（供 crawler 写入 discarded.detail）。
 * contentA = 刚抓取的清洗正文，contentB = 匹配文章 cleanContent（均为纯文本）。
 */
function buildCollectEvidence(
  result: NearDuplicateResult,
  titleA: string, contentA: string,
  titleB: string, contentB: string,
  matched: { id: string; url: string; title: string },
  cfg: DedupConfig,
): DedupEvidence {
  const base = (methodKey: string, method: string, detail: string, extra: Partial<DedupEvidence> = {}): DedupEvidence => ({
    methodKey,
    method,
    matchedTitle: matched.title,
    matchedUrl: matched.url,
    matchedId: matched.id,
    similarity: result.similarity,
    detail,
    ...extra,
  });

  switch (result.signal) {
    case 'fingerprint': {
      const sample = (contentB || contentA).slice(0, 60);
      return base(
        'fingerprint', '内容指纹 (SHA-256)',
        '整篇内容指纹完全一致（转载 / 通稿，正文一字不差）',
        sample ? {
          snippets: [{
            label: '内容首段（两篇完全相同）',
            currentBefore: '', currentShared: sample, currentAfter: '',
            matchedBefore: '', matchedShared: sample, matchedAfter: '',
          }],
        } : {},
      );
    }
    case 'title_jaccard': {
      const sim = result.titleSim ?? result.similarity;
      const titleSnip = buildTitleSnippet(titleA, titleB);
      return base(
        'title_jaccard', '标题相似 (Jaccard bigram)',
        `标题 Jaccard 相似度 ${sim.toFixed(2)}（仅作辅助证据，不单独判重）`,
        { similarity: sim, snippets: titleSnip ? [titleSnip] : undefined },
      );
    }
    case 'body_lcs': {
      const total = result.lcsTotal ?? 0;
      const snippets = buildLcsSnippets(stripWs(contentA), stripWs(contentB), cfg.bodyLcsMin);
      return base(
        'body_lcs', '正文重叠 (多段 LCS)',
        `正文公共串总长 ${total} 字符（≥ 阈值 ${cfg.lcsTotalMin}）`,
        { snippets },
      );
    }
    default:
      return base('unknown', '未知', result.dedupType || '');
  }
}

export async function findDuplicateArticle(
  title: string,
  content: string,
  excludeId?: string,
  sourceId?: string,
): Promise<NearDuplicateResult> {
  const cfg = await getDedupConfig(sourceId);
  const incomingFingerprint = computeContentFingerprint(title, content);
  // 预计算 incoming title 的 bigrams：循环里每个候选都要复用，500 次重复构建 Set 太贵
  const incomingBigrams = getBigrams(title);

  const fingerprintMatches = await db.article.findMany({
    where: {
      contentHash: incomingFingerprint,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, url: true, title: true, contentHash: true, cleanContent: true, publishedAt: true },
    take: DEDUP_CANDIDATE_CAP,
  });
  // 兼容旧版本“只哈希前 1000 字”的历史数据：数据库命中后必须用当前全文算法复核。
  const fingerprintMatch = fingerprintMatches.find(article =>
    computeContentFingerprint(article.title, article.cleanContent || '') === incomingFingerprint
  );
  if (fingerprintMatch) {
    const matched = { id: fingerprintMatch.id, url: fingerprintMatch.url, title: fingerprintMatch.title };
    return {
      isDuplicate: true,
      dedupType: 'content_fingerprint',
      similarity: 1.0,
      signal: 'fingerprint',
      matchedId: fingerprintMatch.id,
      matchedUrl: fingerprintMatch.url,
      matchedTitle: fingerprintMatch.title,
      matchedPublishedAt: fingerprintMatch.publishedAt,
      evidence: buildCollectEvidence(
        { signal: 'fingerprint', similarity: 1.0 } as NearDuplicateResult,
        title, content, fingerprintMatch.title, fingerprintMatch.cleanContent || content,
        matched, cfg,
      ),
    };
  }

  const windowStart = new Date(Date.now() - cfg.windowDays * DAY_MS);
  const recentArticles = await db.article.findMany({
    where: {
      AND: [
        dedupWindowWhere(windowStart),
        ...(excludeId ? [{ id: { not: excludeId } }] : []),
      ],
    },
    select: { id: true, url: true, title: true, cleanContent: true, contentHash: true, publishedAt: true },
    take: DEDUP_CANDIDATE_CAP,
    orderBy: { createdAt: 'desc' },
  });
  if (recentArticles.length === DEDUP_CANDIDATE_CAP) {
    console.warn(`[findDuplicateArticle] 候选命中上限 ${DEDUP_CANDIDATE_CAP}，窗口内更早的近重复可能被截断漏判`);
  }

  for (const article of recentArticles) {
    const result = isNearDuplicateInternal(
      title, content,
      article.title, article.cleanContent || '',
      cfg,
      undefined,
      incomingBigrams,
      incomingFingerprint,
    );
    if (result.isDuplicate) {
      const matched = { id: article.id, url: article.url, title: article.title };
      return {
        ...result,
        matchedId: article.id,
        matchedUrl: article.url,
        matchedTitle: article.title,
        matchedPublishedAt: article.publishedAt,
        evidence: buildCollectEvidence(
          result, title, content, article.title, article.cleanContent || '', matched, cfg,
        ),
      };
    }
  }

  return { isDuplicate: false, dedupType: null, similarity: 0 };
}

/** 导出供测试：AI 前正文同事件判定 */
export function isSameEventByBodyForTest(
  a: ArticleBodyView,
  b: ArticleBodyView,
  numsA: Set<string>,
  numsB: Set<string>,
  cfg: DedupConfig,
): boolean {
  return isSameEventByBodyInternal(a, b, numsA, numsB, cfg);
}

// ---------------------------------------------------------------------------
// AI 前去重 — dedupBeforeAI（合并 L3 pending↔pending + P0 pending↔done）
//
// 在 analyzeAllPending 开头跑一次：
//   - pending 集内 O(N²) 互查（按 publishedAt 窗口 break）
//   - 每篇 pending vs 近期 done 候选
//   - 命中即标 skipped（pending↔pending 保留更老；pending↔done 保留 done）
// 之后 processWithAI 只处理未 skipped 的 pending，不再单独查 P0。
// ---------------------------------------------------------------------------

export async function dedupBeforeAI(
  signal?: AbortSignal,
): Promise<{ checked: number; skipped: number }> {
  const checkAborted = () => { if (signal?.aborted) throw new Error('Aborted'); };

  const cfg = await getDedupConfig();
  const pendingWindowAgo = new Date(Date.now() - cfg.windowDays * DAY_MS);
  const pending = await db.article.findMany({
    where: {
      AND: [
        dedupWindowWhere(pendingWindowAgo),
        { aiStatus: 'pending' },
        { fetchStatus: 'fetched' },
        { cleanContent: { not: '' } },
        { dedupOverride: false },
      ],
    },
    select: { id: true, title: true, url: true, cleanContent: true, publishedAt: true, createdAt: true },
    take: DEDUP_CANDIDATE_CAP,
    orderBy: { publishedAt: 'asc' },
  });

  if (pending.length < 1) return { checked: pending.length, skipped: 0 };
  if (pending.length === DEDUP_CANDIDATE_CAP) {
    console.warn(`[dedupBeforeAI] pending 命中上限 ${DEDUP_CANDIDATE_CAP}，本轮未覆盖的 pending 将留到下轮`);
  }

  const windowStart = new Date(Date.now() - cfg.windowDays * DAY_MS);
  const doneCandidates = await db.article.findMany({
      where: { AND: [dedupWindowWhere(windowStart), { aiStatus: 'done' }, { dedupOverride: false }] },
    select: { id: true, title: true, url: true, cleanContent: true, publishedAt: true, createdAt: true },
    take: DEDUP_DONE_CAP,
    orderBy: { createdAt: 'desc' },
  });
  if (doneCandidates.length === DEDUP_DONE_CAP) {
    console.warn(`[dedupBeforeAI] done 候选命中上限 ${DEDUP_DONE_CAP}，更早的 done 可能未参与比对`);
  }

  // 有效时间：publishedAt 优先，回退 createdAt。
  // 源无可解析日期时 publishedAt 为 null（crawler 置 undefined），若不回退这些文章
  // 会整体绕过 before-AI 去重（既漏判又白白消耗 AI 调用）。dedupWindowWhere 已按同样
  // 规则筛选窗口，这里与之保持一致。
  const effTime = (x: { publishedAt: Date | null; createdAt: Date }): number =>
    effectiveArticleTime(x).getTime();
  // 按有效时间升序排，保证 pending↔pending 的窗口 break 单调有效
  // （DB orderBy publishedAt 对 null 行排序不可靠）。
  pending.sort((x, y) => effTime(x) - effTime(y));

  const WINDOW_MS = cfg.windowDays * DAY_MS;
  const skipIds = new Set<string>();
  let skipped = 0;

  const numericCache = new Map<string, Set<string>>();
  const getNumerics = (id: string, content: string) => {
    let n = numericCache.get(id);
    if (!n) { n = extractNumericValues(content); numericCache.set(id, n); }
    return n;
  };

  // 判定结果必须先落库，再允许 analyze 查询 pending；否则异步写入会产生竞态，
  // 被判重文章仍可能被送入 AI。重复命中通常远少于候选比较次数，写入正确性优先。
  const markSkip = async (newerId: string, reason: string, evidence: DedupEvidence): Promise<boolean> => {
    if (skipIds.has(newerId)) return false;
    try {
      await db.article.update({
        where: { id: newerId },
        data: { aiStatus: 'skipped', score: 0, skipReason: reason, dedupDetail: JSON.stringify(evidence), duplicateStatus: 'duplicate', duplicateOfId: evidence.matchedId ?? null },
      });
      skipIds.add(newerId);
      skipped++;
      return true;
    } catch (err) {
      console.error('[dedupBeforeAI] failed to skip article:', err);
      return false;
    }
  };

  /**
   * 由 body 信号构造 skipReason + DedupEvidence。
   * reason 字符串保留 "[重复] 与 \"title\" 正文(数值)重叠 (...)" 形态：
   * 列表 UI 用 /与\s*"([^"]+)"/ 抽标题、shortSkipLabel 用 includes('正文...重叠') 归类，不可破坏。
   * newer = 被标记跳过的那篇（详情页展示其证据）；older = 胜出（matched）。
   */
  const buildBodySkip = (
    signal: BodySignal,
    newer: { id: string; url: string; title: string },
    older: { id: string; url: string; title: string },
    sharedValues: string[],
    newerContent: string,
    olderContent: string,
  ): { reason: string; evidence: DedupEvidence } => {
    const svStr = formatSharedValuesStr(sharedValues.length, sharedValues, cfg.numericSharedMin);
    const aStrip = stripWs(newerContent);
    const bStrip = stripWs(olderContent);
    let methodKey: string; let method: string; let detail: string; let reason: string;
    let snippets: DedupSnippet[] | undefined;
    if (signal === 'numeric') {
      methodKey = 'numeric'; method = '正文数值重叠';
      detail = `正文共享 ${svStr}`;
      reason = `[重复] 与 "${older.title}" 正文数值重叠 (${svStr})`;
      snippets = buildNumericSnippets(aStrip, bStrip, sharedValues);
    } else if (signal === 'numeric_lcs') {
      methodKey = 'numeric_lcs'; method = '数值 + 正文重叠';
      detail = `1 个共享数值 + 同日 + 正文多段 LCS 确认（${svStr}）`;
      reason = `[重复] 与 "${older.title}" 正文数值重叠 (${svStr}) 同日+LCS确认`;
      snippets = [
        ...buildNumericSnippets(aStrip, bStrip, sharedValues),
        ...buildLcsSnippets(aStrip, bStrip, cfg.bodyLcsMin),
      ];
    } else {
      methodKey = 'body_lcs'; method = '正文重叠 (多段 LCS)';
      detail = `两篇短文正文多段 LCS 总长 ≥ ${cfg.lcsTotalMin} 字符`;
      reason = `[重复] 与 "${older.title}" 正文重叠 (短文多段LCS≥${cfg.lcsTotalMin}字符)`;
      snippets = buildLcsSnippets(aStrip, bStrip, cfg.bodyLcsMin, 3, cfg.shortBodyThreshold);
    }
    return {
      reason,
      evidence: {
        methodKey, method,
        matchedTitle: older.title, matchedUrl: older.url, matchedId: older.id,
        detail,
        sharedValues: sharedValues.length > 0 ? sharedValues : undefined,
        snippets,
      },
    };
  };

  for (let i = 0; i < pending.length; i++) {
    checkAborted();
    const a = pending[i];
    if (skipIds.has(a.id)) continue;
    const aContent = a.cleanContent || '';
    const numsA = getNumerics(a.id, aContent);
    const aTime = effTime(a);

    // pending↔pending（按有效时间升序，超窗口 break）
    for (let j = i + 1; j < pending.length; j++) {
      const b = pending[j];
      const bTime = effTime(b);
      if (bTime - aTime > WINDOW_MS) break;
      if (skipIds.has(b.id)) continue;

      const numsB = getNumerics(b.id, b.cleanContent || '');
      const chk = checkBodyDup(a, b, numsA, numsB, cfg);
      if (chk.isDuplicate) {
        // 保留有效时间更早的一篇，标记更晚的（升序下 newer 恒为 b）
        const newerIsA = aTime > bTime;
        const newer = newerIsA ? a : b;
        const older = newerIsA ? b : a;
        const [smaller, larger] = numsA.size < numsB.size ? [numsA, numsB] : [numsB, numsA];
        const sv = getSharedNumericValues(smaller, larger);
        const { reason, evidence } = buildBodySkip(
          chk.signal, newer, older, sv.values,
          (newerIsA ? aContent : b.cleanContent) || '',
          (newerIsA ? b.cleanContent : aContent) || '',
        );
        if (await markSkip(newer.id, reason, evidence)) {
          console.log(`[dedupBeforeAI] pending↔pending: "${newer.title}" dup of "${older.title}"`);
        }
      }
    }

    // pending↔done（保留 done：已花 AI 成本；标 pending 为重复）
    if (skipIds.has(a.id)) continue;
    for (const d of doneCandidates) {
      checkAborted();
      if (Math.abs(effTime(d) - aTime) > WINDOW_MS) continue;

      const numsD = getNumerics(d.id, d.cleanContent || '');
      const chk = checkBodyDup(a, d, numsA, numsD, cfg);
      if (chk.isDuplicate) {
        const [smaller, larger] = numsA.size < numsD.size ? [numsA, numsD] : [numsD, numsA];
        const sv = getSharedNumericValues(smaller, larger);
        const { reason, evidence } = buildBodySkip(
          chk.signal, a, d, sv.values, aContent, d.cleanContent || '',
        );
        if (await markSkip(a.id, reason, evidence)) {
          console.log(`[dedupBeforeAI] pending↔done: "${a.title}" dup of "${d.title}" — AI call saved`);
          break;
        }
      }
    }
  }

  return { checked: pending.length, skipped };
}

