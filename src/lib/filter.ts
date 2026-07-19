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

const cache = createCache<KeywordCache>(5 * 60 * 1000);

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
  const { words } = await getCachedKeywords();
  if (words.length === 0) return true;
  const lowerText = text.toLowerCase();
  return words.some(kw => lowerText.includes(kw));
}

export function invalidateKeywordCache(): void {
  cache.invalidate();
}
