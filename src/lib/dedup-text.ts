import crypto from 'crypto';
import type { DedupSnippet } from './dedup-evidence';
import { extractNumericMatches } from './dedup-numeric';

const SNIPPET_CONTEXT = 20;

export function jaccardSimilarity(
  a: string,
  b: string,
  bigramsA?: Set<string>,
  bigramsB?: Set<string>,
): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const aSet = bigramsA ?? getBigrams(a);
  const bSet = bigramsB ?? getBigrams(b);
  if (aSet.size === 0 && bSet.size === 0) return 1;
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let intersection = 0;
  for (const bg of aSet) if (bSet.has(bg)) intersection++;
  const union = aSet.size + bSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function getBigrams(str: string): Set<string> {
  const normalized = str.replace(/\s+/g, '').toLowerCase();
  const bigrams = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) {
    bigrams.add(normalized.substring(i, i + 2));
  }
  return bigrams;
}

function findLongestCommonSubstringDetail(
  a: string,
  b: string,
): { length: number; substr: string; aStart: number; bStart: number } | null {
  if (!a || !b) return null;
  const m = a.length;
  const n = b.length;
  let maxLen = 0;
  let maxI = 0;
  let maxJ = 0;
  const prev = new Uint16Array(n + 1);
  const curr = new Uint16Array(n + 1);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > maxLen) {
          maxLen = curr[j];
          maxI = i - maxLen;
          maxJ = j - maxLen;
        }
      } else {
        curr[j] = 0;
      }
    }
    prev.set(curr);
    curr.fill(0);
  }
  if (maxLen === 0) return null;
  return { length: maxLen, substr: a.slice(maxI, maxI + maxLen), aStart: maxI, bStart: maxJ };
}

export function longestCommonSubstring(a: string, b: string): number {
  return findLongestCommonSubstringDetail(a, b)?.length ?? 0;
}

export function totalLcsRunLength(a: string, b: string, minRun: number, maxLen = 5000): number {
  if (!a || !b) return 0;
  if (a === b) return Math.min(a.length, maxLen);
  let aRem = a.slice(0, maxLen);
  let bRem = b.slice(0, maxLen);
  let total = 0;
  // 不删除命中的片段，避免删除后把前后两段拼接成新的“公共串”。
  // 两侧使用不同占位符，既保留边界，又不会让占位符互相匹配。
  const MASK_A = '\u0000';
  const MASK_B = '\u0001';
  const MAX_ITER = 20;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const detail = findLongestCommonSubstringDetail(aRem, bRem);
    if (!detail || detail.length < minRun) break;
    total += detail.length;
    aRem = aRem.slice(0, detail.aStart) + MASK_A.repeat(detail.length) + aRem.slice(detail.aStart + detail.length);
    bRem = bRem.slice(0, detail.bStart) + MASK_B.repeat(detail.length) + bRem.slice(detail.bStart + detail.length);
  }
  return total;
}

export function buildLcsSnippets(
  textA: string,
  textB: string,
  minRun: number,
  maxSegments = 3,
  maxLen = 5000,
): DedupSnippet[] {
  if (!textA || !textB) return [];
  const a = textA.slice(0, maxLen);
  const b = textB.slice(0, maxLen);
  const aMask = a.split('');
  const bMask = b.split('');
  const SENT_A = '\u0000';
  const SENT_B = '\u0001';
  const snippets: DedupSnippet[] = [];
  const MAX_ITER = maxSegments * 4;
  for (let i = 0; i < MAX_ITER && snippets.length < maxSegments; i++) {
    const detail = findLongestCommonSubstringDetail(aMask.join(''), bMask.join(''));
    if (!detail || detail.length < minRun) break;
    const sa = detail.aStart;
    const sb = detail.bStart;
    const len = detail.length;
    snippets.push({
      label: `公共片段 ${snippets.length + 1}`,
      currentBefore: a.slice(Math.max(0, sa - SNIPPET_CONTEXT), sa),
      currentShared: detail.substr,
      currentAfter: a.slice(sa + len, sa + len + SNIPPET_CONTEXT),
      matchedBefore: b.slice(Math.max(0, sb - SNIPPET_CONTEXT), sb),
      matchedShared: detail.substr,
      matchedAfter: b.slice(sb + len, sb + len + SNIPPET_CONTEXT),
    });
    for (let k = 0; k < len; k++) {
      aMask[sa + k] = SENT_A;
      bMask[sb + k] = SENT_B;
    }
  }
  return snippets;
}

export function buildNumericSnippets(
  textA: string,
  textB: string,
  sharedValues: string[],
  max = 5,
): DedupSnippet[] {
  if (!textA || !textB || sharedValues.length === 0) return [];
  const matchesA = extractNumericMatches(textA);
  const matchesB = extractNumericMatches(textB);
  const snippets: DedupSnippet[] = [];
  for (const value of sharedValues) {
    if (snippets.length >= max) break;
    const a = matchesA.find(m => m.normalized === value);
    const b = matchesB.find(m => m.normalized === value);
    if (!a || !b) continue;
    snippets.push({
      label: value,
      currentBefore: textA.slice(Math.max(0, a.index - SNIPPET_CONTEXT), a.index),
      currentShared: a.raw,
      currentAfter: textA.slice(a.index + a.raw.length, a.index + a.raw.length + SNIPPET_CONTEXT),
      matchedBefore: textB.slice(Math.max(0, b.index - SNIPPET_CONTEXT), b.index),
      matchedShared: b.raw,
      matchedAfter: textB.slice(b.index + b.raw.length, b.index + b.raw.length + SNIPPET_CONTEXT),
    });
  }
  return snippets;
}

export function buildTitleSnippet(titleA: string, titleB: string): DedupSnippet | null {
  const detail = findLongestCommonSubstringDetail(titleA, titleB);
  if (!detail || detail.length < 2) return null;
  const sa = detail.aStart;
  const sb = detail.bStart;
  const len = detail.length;
  return {
    label: '标题',
    currentBefore: titleA.slice(0, sa),
    currentShared: detail.substr,
    currentAfter: titleA.slice(sa + len),
    matchedBefore: titleB.slice(0, sb),
    matchedShared: detail.substr,
    matchedAfter: titleB.slice(sb + len),
  };
}

function cleanTextForFingerprint(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-zA-Z0-9#]+;/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function computeContentFingerprint(title: string, content: string): string {
  // 指纹必须覆盖全文。只取前 1000 字会把“前半段相同、后半段不同”的文章误判为完全重复。
  const cleanedContent = cleanTextForFingerprint(content);
  // 标题可能因媒体改写、标点或副标题不同；完全相同的正文仍属于同一篇转载。
  void title;
  return crypto.createHash('sha256').update(cleanedContent, 'utf8').digest('hex');
}

export const stripWs = (s: string) => s.replace(/\s+/g, '');
export const stripLen = (s: string) => stripWs(s).length;
export const sameDay = (a: Date | null | undefined, b: Date | null | undefined): boolean =>
  !!a && !!b && a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
