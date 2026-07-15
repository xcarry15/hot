import { db } from './db';
import { getDedupConfig, type DedupConfig } from './dedup-config';
import {
  extractNumericValues,
  getSharedNumericValues,
  isDistinctiveNumericValue,
  keyPointsToText,
} from './dedup-numeric';
import { DAY_MS, DEDUP_AFTER_CAP, dedupWindowWhere, effectiveArticleTime, formatSharedValuesStr } from './dedup-shared';
import { buildLcsSnippets, buildNumericSnippets, sameDay, stripWs, totalLcsRunLength } from './dedup-text';
import type { DedupEvidence, DedupSnippet } from './dedup-evidence';
import { splitBrands } from './shared/article-codecs';

export interface KeyPointsDuplicateResult {
  isDuplicate: boolean;
  matchedId?: string;
  matchedTitle?: string;
  matchedUrl?: string;
  sharedCount: number;
  sharedValues: string[];
  skipReason: string;
  evidence?: DedupEvidence;
}

export interface KeyPointsView {
  brand: string;
  keyPoints: string;
  publishedAt: Date | null;
  createdAt?: Date | null;
}

function normalizeBrand(b: string): string {
  return b.trim().toLowerCase().replace(/\s+/g, '');
}

function brandCore(b: string): string {
  let core = normalizeBrand(b);
  // 只剥离企业法律后缀，不做任意子串包含，避免“苹果”误合并“苹果醋”。
  for (const suffix of ['股份有限公司', '有限责任公司', '有限公司', '集团', '控股', '股份', '公司']) {
    if (core.length > suffix.length && core.endsWith(suffix)) {
      core = core.slice(0, -suffix.length);
      break;
    }
  }
  return core;
}

function brandOverlap(a: string[], b: string[]): boolean {
  const aCores = a.map(brandCore).filter(Boolean);
  const bCores = b.map(brandCore).filter(Boolean);
  return aCores.some(x => bCores.includes(x));
}

function sameEffectiveDay(a: KeyPointsView, b: KeyPointsView): boolean {
  return sameDay(a.publishedAt ?? a.createdAt ?? null, b.publishedAt ?? b.createdAt ?? null);
}

function isSameEventByKeyPointsInternal(
  current: KeyPointsView,
  candidate: KeyPointsView,
  cfg: DedupConfig,
  currentBrands: string[],
  shared: number,
): boolean {
  return checkKeyPointsDup(current, candidate, cfg, currentBrands, shared).isDuplicate;
}

type KeyPointsSignal = 'numeric' | 'numeric_lcs' | 'keypoints_lcs' | null;

function checkKeyPointsDup(
  current: KeyPointsView,
  candidate: KeyPointsView,
  cfg: DedupConfig,
  currentBrands: string[],
  shared: number,
  sharedValues?: string[],
): { isDuplicate: boolean; signal: KeyPointsSignal } {
  const candidateBrands = splitBrands(candidate.brand || '').map(normalizeBrand);
  if (cfg.brandGateEnabled && !brandOverlap(currentBrands, candidateBrands)) {
    return { isDuplicate: false, signal: null };
  }

  const hasDistinctiveValue = !sharedValues || sharedValues.some(isDistinctiveNumericValue);
  if (shared >= cfg.numericSharedMin && hasDistinctiveValue) {
    return { isDuplicate: true, signal: 'numeric' };
  }
  if (shared >= 1 && sameEffectiveDay(current, candidate)) {
    const total = totalLcsRunLength(
      stripWs(current.keyPoints),
      stripWs(candidate.keyPoints),
      cfg.bodyLcsMin,
    );
    if (total >= cfg.lcsTotalMin) return { isDuplicate: true, signal: 'numeric_lcs' };
  }

  if (current.keyPoints.length >= 80 && candidate.keyPoints.length >= 80) {
    const total = totalLcsRunLength(
      stripWs(current.keyPoints),
      stripWs(candidate.keyPoints),
      cfg.bodyLcsMin,
    );
    if (total >= cfg.lcsTotalMin) return { isDuplicate: true, signal: 'keypoints_lcs' };
  }
  return { isDuplicate: false, signal: null };
}

function buildKeyPointsSkip(
  signal: KeyPointsSignal,
  newerKp: unknown,
  older: { id: string; url: string; title: string },
  olderKp: unknown,
  sharedValues: string[],
  cfg: DedupConfig,
): { reason: string; evidence: DedupEvidence } {
  const svStr = formatSharedValuesStr(sharedValues.length, sharedValues, cfg.numericSharedMin);
  const newerText = stripWs(keyPointsToText(newerKp));
  const olderText = stripWs(keyPointsToText(olderKp));
  let methodKey: string; let method: string; let detail: string; let reason: string;
  let snippets: DedupSnippet[] | undefined;
  if (signal === 'keypoints_lcs') {
    methodKey = 'keypoints_lcs'; method = '要点重叠 (LCS)';
    detail = `要点多段 LCS 总长 ≥ ${cfg.lcsTotalMin} 字符`;
    reason = `[重复] 与 "${older.title}" 要点重叠 (LCS≥${cfg.lcsTotalMin}字符)`;
    snippets = buildLcsSnippets(newerText, olderText, cfg.bodyLcsMin);
  } else if (signal === 'numeric_lcs') {
    methodKey = 'numeric_lcs'; method = '数值 + 要点重叠';
    detail = `共享事件数值 + 同日 + 要点多段 LCS 确认（${svStr}）`;
    reason = `[重复] 与 "${older.title}" 报道同一事件 (${svStr}) 同日+要点LCS确认`;
    snippets = [
      ...buildNumericSnippets(newerText, olderText, sharedValues),
      ...buildLcsSnippets(newerText, olderText, cfg.bodyLcsMin),
    ];
  } else {
    methodKey = 'numeric'; method = '要点数值重叠';
    detail = `要点共享 ${svStr}`;
    reason = `[重复] 与 "${older.title}" 报道同一事件 (${svStr})`;
    snippets = buildNumericSnippets(newerText, olderText, sharedValues);
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
}

export function isSameEventByKeyPointsForTest(
  current: KeyPointsView,
  candidate: KeyPointsView,
  cfg: DedupConfig,
  currentBrands: string[],
  shared: number,
): boolean {
  return isSameEventByKeyPointsInternal(current, candidate, cfg, currentBrands, shared);
}

export async function dedupAfterAI(
  articleId: string,
  brand: string,
  keyPoints: unknown,
  publishedAt?: Date | null,
  createdAt?: Date | null,
): Promise<KeyPointsDuplicateResult> {
  if (!brand) return { isDuplicate: false, sharedCount: 0, sharedValues: [], skipReason: '' };

  const currentKpText = typeof keyPoints === 'string' ? keyPoints : JSON.stringify(keyPoints);
  const currentBrands = splitBrands(brand).map(normalizeBrand).filter(Boolean);
  if (currentBrands.length === 0) return { isDuplicate: false, sharedCount: 0, sharedValues: [], skipReason: '' };

  const cfg = await getDedupConfig();
  const windowStart = new Date(Date.now() - cfg.windowDays * DAY_MS);

  const brandQueryTerms = [...new Set(currentBrands.map(brandCore).filter(Boolean))];
  const candidates = await db.article.findMany({
    where: {
      AND: [
        dedupWindowWhere(windowStart),
        { id: { not: articleId } },
        { aiStatus: 'done' },
        { dedupOverride: false },
        { OR: brandQueryTerms.map(b => ({ brand: { contains: b } })) },
      ],
    },
    select: { id: true, title: true, url: true, keyPoints: true, brand: true, publishedAt: true, createdAt: true },
    take: DEDUP_AFTER_CAP,
    orderBy: { createdAt: 'desc' },
  });
  if (candidates.length === DEDUP_AFTER_CAP) {
    console.warn(`[dedupAfterAI] 同品牌候选命中上限 ${DEDUP_AFTER_CAP}，更早的同品牌 done 可能未参与比对`);
  }

  const current: KeyPointsView = { brand, keyPoints: currentKpText, publishedAt: publishedAt ?? null, createdAt: createdAt ?? null };
  const currentTime = (publishedAt ?? createdAt ?? new Date()).getTime();
  const currentNums = extractNumericValues(currentKpText);

  for (const candidate of candidates) {
    const candidateBrands = splitBrands(candidate.brand || '').map(normalizeBrand);
    if (!brandOverlap(currentBrands, candidateBrands)) continue;
    if (Math.abs(effectiveArticleTime(candidate).getTime() - currentTime) > cfg.windowDays * DAY_MS) continue;

    const candidateKpText = candidate.keyPoints ?? '[]';
    const candidateNums = extractNumericValues(candidateKpText);
    const [smaller, larger] = currentNums.size < candidateNums.size ? [currentNums, candidateNums] : [candidateNums, currentNums];
    const sv = getSharedNumericValues(smaller, larger);

    const chk = checkKeyPointsDup(
      current,
      { brand: candidate.brand || '', keyPoints: candidateKpText, publishedAt: candidate.publishedAt, createdAt: candidate.createdAt },
      cfg,
      currentBrands,
      sv.count,
      sv.values,
    );
    if (chk.isDuplicate) {
      const older = { id: candidate.id, url: candidate.url, title: candidate.title };
      const { reason, evidence } = buildKeyPointsSkip(
        chk.signal, keyPoints, older, candidateKpText, sv.values, cfg,
      );
      return {
        isDuplicate: true,
        matchedId: candidate.id,
        matchedTitle: candidate.title,
        matchedUrl: candidate.url,
        sharedCount: sv.count,
        sharedValues: sv.values,
        skipReason: reason,
        evidence,
      };
    }
  }

  return { isDuplicate: false, sharedCount: 0, sharedValues: [], skipReason: '' };
}

export async function dedupAfterAiBatch(
  articleIds: string[],
  signal?: AbortSignal,
): Promise<{ checked: number; skipped: number }> {
  if (articleIds.length < 2) return { checked: articleIds.length, skipped: 0 };
  const checkAborted = () => { if (signal?.aborted) throw new Error('Aborted'); };

  const cfg = await getDedupConfig();
  const articles = await db.article.findMany({
    where: { id: { in: articleIds }, aiStatus: 'done', dedupOverride: false },
    select: { id: true, title: true, url: true, brand: true, keyPoints: true, publishedAt: true, createdAt: true },
  });
  if (articles.length < 2) return { checked: articleIds.length, skipped: 0 };

  // Prisma 不保证 IN 查询顺序；按有效时间排序，保证旧文章稳定胜出。
  articles.sort((a, b) => {
    const delta = effectiveArticleTime(a).getTime() - effectiveArticleTime(b).getTime();
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });

  let skipped = 0;
  const skipIds = new Set<string>();

  for (let i = 0; i < articles.length; i++) {
    checkAborted();
    const a = articles[i];
    if (skipIds.has(a.id) || !a.brand) continue;
    const aBrands = splitBrands(a.brand).map(normalizeBrand).filter(Boolean);
    if (aBrands.length === 0) continue;
    const aKpText = a.keyPoints ?? '[]';
    const aNums = extractNumericValues(aKpText);

    for (let j = i + 1; j < articles.length; j++) {
      checkAborted();
      const b = articles[j];
      if (skipIds.has(b.id) || !b.brand) continue;
      if (Math.abs(effectiveArticleTime(a).getTime() - effectiveArticleTime(b).getTime()) > cfg.windowDays * DAY_MS) continue;
      const bBrands = splitBrands(b.brand).map(normalizeBrand);
      if (!brandOverlap(aBrands, bBrands)) continue;

      const bKpText = b.keyPoints ?? '[]';
      const bNums = extractNumericValues(bKpText);
      const [smaller, larger] = aNums.size < bNums.size ? [aNums, bNums] : [bNums, aNums];
      const sv = getSharedNumericValues(smaller, larger);

      const chk = checkKeyPointsDup(
        { brand: a.brand, keyPoints: aKpText, publishedAt: a.publishedAt, createdAt: a.createdAt },
        { brand: b.brand, keyPoints: bKpText, publishedAt: b.publishedAt, createdAt: b.createdAt },
        cfg,
        aBrands,
        sv.count,
        sv.values,
      );
      if (!chk.isDuplicate) continue;

      const aDate = effectiveArticleTime(a).getTime();
      const bDate = effectiveArticleTime(b).getTime();
      const newerIsA = aDate > bDate || (aDate === bDate && a.id > b.id);
      const newer = newerIsA ? a : b;
      const older = newerIsA ? b : a;
      const newerKpText = newerIsA ? aKpText : bKpText;
      const olderKpText = newerIsA ? bKpText : aKpText;

      const olderMeta = { id: older.id, url: older.url, title: older.title };
      const { reason, evidence } = buildKeyPointsSkip(
        chk.signal, newerKpText, olderMeta, olderKpText, sv.values, cfg,
      );

      try {
        await db.article.update({
          where: { id: newer.id },
          data: {
            aiStatus: 'skipped',
            score: 0,
            skipReason: reason,
            dedupDetail: JSON.stringify(evidence),
            duplicateStatus: 'duplicate',
            duplicateOfId: evidence.matchedId ?? null,
          },
        });
      } catch (err) {
        console.error('[dedupAfterAiBatch] failed to skip article:', err);
        continue;
      }

      console.log(
        `[dedupAfterAiBatch] "${newer.title}" marked as duplicate of ` +
        `"${older.title}" (${sv.count} shared values, brand=${a.brand})`
      );
      skipIds.add(newer.id);
      skipped++;
    }
  }

  return { checked: articleIds.length, skipped };
}
