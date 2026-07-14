export interface NumMatch {
  raw: string
  normalized: string
  index: number
}

function normalizeNumericValue(value: string): string {
  value = value.replace(/,/g, '').replace(/\s+/g, '');
  const m = value.match(/^([\d.]+)(亿|万|千|百)?(.*)$/);
  if (!m) return value;
  const numStr = m[1];
  const mag = m[2] || '';
  const suffix = m[3] || '';

  const base = parseFloat(numStr);
  if (!Number.isFinite(base)) return value;

  const multiplier = mag === '亿' ? 1e8 : mag === '万' ? 1e4 : mag === '千' ? 1e3 : mag === '百' ? 1e2 : 1;
  const actual = base * multiplier;

  // 单位是事实的一部分，不能把“100万元”和“100万人”都归一化成“100万”。
  if (actual >= 1e8) return `${actual / 1e8}亿${suffix}`;
  if (actual >= 1e4) return `${actual / 1e4}万${suffix}`;
  return `${actual}${suffix}`;
}

function normalizeChineseMagnitude(raw: string): string | null {
  const cleaned = raw.replace(/\s+/g, '');
  if (cleaned === '亿万') return '1亿';

  const m = cleaned.match(/^([一二两三四五六七八九十百千万亿]+)([万亿])$/);
  if (!m) return null;

  const prefix = m[1];
  const magnitude = m[2];
  const digitMap: Record<string, number> = {
    '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9,
  };

  let value = 0;
  let current = 0;
  for (const ch of prefix) {
    if (ch === '亿') { if (current === 0) current = 1; value += current * 100000000; current = 0; }
    else if (ch === '万') { if (current === 0) current = 1; value += current * 10000; current = 0; }
    else if (ch === '十') { if (current === 0) current = 1; value += current * 10; current = 0; }
    else if (ch === '百') { if (current === 0) current = 1; value += current * 100; current = 0; }
    else if (ch === '千') { if (current === 0) current = 1; value += current * 1000; current = 0; }
    else { current = digitMap[ch] || 0; }
  }
  value += current;

  if (value === 0) return null;
  if (magnitude === '万') value *= 10000;
  else if (magnitude === '亿') value *= 100000000;
  if (value < 10000) return null;

  if (value >= 1e8 && value % 1e8 === 0) return `${value / 1e8}亿`;
  if (value >= 1e4 && value % 1e4 === 0) return `${value / 1e4}万`;
  return `${value}`;
}

export function keyPointsToText(keyPoints: unknown): string {
  let arr: string[] = [];
  if (Array.isArray(keyPoints)) {
    arr = keyPoints.filter((x): x is string => typeof x === 'string');
  } else if (typeof keyPoints === 'string' && keyPoints.length > 0) {
    try {
      const parsed = JSON.parse(keyPoints);
      arr = Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === 'string')
        : [keyPoints];
    } catch {
      arr = [keyPoints];
    }
  }
  return arr.join('\n');
}

export function extractNumericMatches(text: string): NumMatch[] {
  const matches: NumMatch[] = [];
  if (!text) return matches;

  const numRegex = /[\d,.]+(?:\s*(?:亿|万|千|百))?\s*(?:平方米|平米|港元|美元|欧元|日元|%|％|元|块|家|店|倍|吨|亩|人次|天|年|轮|次|个|位|项)?/g;
  const chineseMagRegex = /[一二两三四五六七八九十百千万亿]+[万亿]/g;

  let m: RegExpExecArray | null;
  while ((m = numRegex.exec(text)) !== null) {
    let normalized = m[0].replace('％', '%');
    normalized = normalized.replace(/\s+/g, '');
    const stripped = normalized.replace(/,/g, '');
    if (/^[\d.]+$/.test(stripped)) continue;
    if (/^20\d{2}$/.test(stripped)) continue;
    if (/^20\d{2}年$/.test(stripped)) continue;
    normalized = normalized.replace(/块$/, '元');
    normalized = normalizeNumericValue(normalized);
    matches.push({ raw: m[0], normalized, index: m.index });
  }
  while ((m = chineseMagRegex.exec(text)) !== null) {
    const normalized = normalizeChineseMagnitude(m[0]);
    if (normalized) matches.push({ raw: m[0], normalized, index: m.index });
  }
  return matches;
}

export function extractNumericValues(keyPoints: unknown): Set<string> {
  return new Set(extractNumericMatches(keyPointsToText(keyPoints)).map(m => m.normalized));
}

export function countSharedNumericValues(textA: string, textB: string, maxChars = 2000): number {
  const valsA = extractNumericValues(textA.slice(0, maxChars));
  const valsB = extractNumericValues(textB.slice(0, maxChars));
  if (valsA.size === 0 || valsB.size === 0) return 0;
  let shared = 0;
  for (const v of valsA) if (valsB.has(v)) shared++;
  return shared;
}

export function getSharedNumericValues(
  smaller: Set<string>,
  larger: Set<string>,
): { count: number; values: string[] } {
  const values: string[] = [];
  for (const v of smaller) if (larger.has(v)) values.push(v);
  return { count: values.length, values };
}

/**
 * 判断数值是否足够有区分度，可以作为“同一事件”的证据。
 * 百分比和极小的金额/计数在新闻正文中出现频率很高，不能单独触发自动去重；
 * 但带量级、带小数或较大计数的值通常更接近事件事实。
 */
export function isDistinctiveNumericValue(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized.includes('%')) return false;

  const numericPart = normalized.replace(/[^\d.]/g, '');
  if (!numericPart || !/\d/.test(numericPart)) return false;
  const number = Number(numericPart);
  if (!Number.isFinite(number)) return false;

  if (/[亿万千百]/.test(normalized)) return true;
  if (numericPart.includes('.')) return true;
  if (number >= 100) return true;
  return /(?:家|店|吨|亩|人次|平方米|平米|元|块|倍|天|年|轮|次|个|位|项)/.test(normalized)
    && number >= 10;
}
