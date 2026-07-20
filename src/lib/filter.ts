import { db } from './db';
import { createCache } from './cache';

/**
 * 关键词过滤 — 单一白名单
 *
 * 命中任意关键词 → 抓取（任务中心中标识"命中"）
 * 未命中 → 丢弃（任务中心中标识"未命中"）
 * DB 为空 → 不过滤（所有文章都算"命中"，返 true）
 */

interface KeywordCache {
  words: string[];
}

export interface KeywordMatchResult {
  configured: boolean;
  matched: boolean;
}

const cache = createCache<KeywordCache>(5 * 60 * 1000);
const INDUSTRY_TITLE_SIGNALS = [
  '餐饮', '餐厅', '饭店', '酒楼', '快餐', '火锅', '烘焙', '茶饮', '咖啡',
  '便利店', '超市', '百货', '购物中心', '商场', '零售', '量贩零食', '门店',
] as const;

async function loadKeywordsFromDb(): Promise<KeywordCache> {
  const rows = await db.keyword.findMany({
    select: { word: true },
  });
  return { words: rows.map(kw => kw.word.toLowerCase()) };
}

async function getCachedKeywords(): Promise<KeywordCache> {
  const cached = cache.get();
  if (cached) return cached;
  const kw = await loadKeywordsFromDb();
  cache.set(kw);
  return kw;
}

/**
 * 检查文本是否命中任意关键词。
 * DB 为空 → 返 true（不过滤）。
 * 否则命中其一即返 true。
 */
export async function matchKeyword(text: string): Promise<boolean> {
  const result = await evaluateKeywordMatch(text);
  return !result.configured || result.matched;
}

/**
 * 返回“是否配置了关键词”和“文本是否真实命中”。
 * 与 matchKeyword 不同，空词库不会伪造命中，可安全用于评分加分。
 */
export async function evaluateKeywordMatch(text: string): Promise<KeywordMatchResult> {
  const { words } = await getCachedKeywords();
  if (words.length === 0) return { configured: false, matched: false };
  const lowerText = text.toLowerCase();
  return { configured: true, matched: words.some(kw => lowerText.includes(kw)) };
}

/**
 * 标题中的强行业信号。
 *
 * 品牌白名单只能回答“关注谁”，无法覆盖“关注什么行业事件”。
 * 这里只保留少量、明确的餐饮/零售业态词，避免用泛化的“商业”、
 * “公司”等词大幅放大噪声。
 */
export function matchIndustryTitleSignal(title: string): boolean {
  const normalized = title.normalize('NFKC').toLowerCase();
  return INDUSTRY_TITLE_SIGNALS.some((signal) => normalized.includes(signal));
}

export function invalidateKeywordCache(): void {
  cache.invalidate();
}
