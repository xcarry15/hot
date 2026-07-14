import { getZAI } from './zai';
import type { SearchFunctionArgs } from 'z-ai-web-dev-sdk';
import type { CrawlResult } from '@/contracts/crawl';
import { assertNotAborted } from './worker-stop';
import { abortableDelay } from './shared/async';

interface WebSearchConfig {
  queries?: string[];      // Search queries to run
  numPerQuery?: number;    // Results per query (default 10)
  recencyDays?: number;    // Only results from last N days
  snippetAsSummary?: boolean; // Use search snippet as summary (default true)
}

/**
 * Web Search Parser — uses z-ai-web-dev-sdk web_search to find industry news
 *
 * This is the most reliable source type for Chinese industry news because:
 * 1. No dependency on specific site structure or CSS selectors
 * 2. No anti-crawler blocking issues
 * 3. Covers multiple sources automatically
 * 4. Fresh results with recency filtering
 *
 * Config format:
 * {
 *   "queries": ["餐饮行业新闻", "连锁品牌动态"],
 *   "numPerQuery": 10,
 *   "recencyDays": 7,
 *   "snippetAsSummary": true
 * }
 */
export async function parseWebSearch(
  sourceUrl: string,
  parserConfigStr: string,
  signal?: AbortSignal,
): Promise<CrawlResult> {
  try {
    const config: WebSearchConfig = JSON.parse(parserConfigStr || '{}');
    const queries = config.queries || extractQueriesFromUrl(sourceUrl);
    const numPerQuery = config.numPerQuery || 10;
    const recencyDays = config.recencyDays || 3;
    const snippetAsSummary = config.snippetAsSummary !== false;

    if (queries.length === 0) {
      return { success: false, items: [], error: 'No search queries configured' };
    }

    const zai = await getZAI();
    const allItems: CrawlResult['items'] = [];
    const seenUrls = new Set<string>();

    // Run queries sequentially with delay to avoid rate limiting (429)
    const queryResults: Array<CrawlResult['items']> = [];
    for (const query of queries) {
      assertNotAborted(signal);
      try {
        const searchArgs: SearchFunctionArgs = {
          query,
          num: numPerQuery,
        };
        if (recencyDays > 0) {
          searchArgs.recency_days = recencyDays;
        }

        const results = await zai.functions.invoke('web_search', searchArgs);
        assertNotAborted(signal);

        if (Array.isArray(results)) {
          const items = results
            .filter((item: { url?: string; name?: string }) => item.url && item.name)
            .map((item: { url: string; name: string; snippet?: string; date?: string; host_name?: string }) => ({
              title: item.name.trim(),
              url: item.url.trim(),
              summary: snippetAsSummary && item.snippet ? item.snippet.trim().substring(0, 300) : '',
              publishedAt: item.date || undefined,
            }));
          queryResults.push(items);
        } else {
          queryResults.push([]);
        }
      } catch (err: unknown) {
        if (signal?.aborted) throw err;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('429') || errMsg.includes('Too many')) {
          // Rate limited — wait and retry once
          console.warn(`[websearch] Rate limited on "${query}", waiting 3s...`);
          await abortableDelay(3000, signal);
          try {
            const retryResults = await zai.functions.invoke('web_search', {
              query,
              num: numPerQuery,
              ...(recencyDays > 0 ? { recency_days: recencyDays } : {}),
            });
            assertNotAborted(signal);
            if (Array.isArray(retryResults)) {
              const items = retryResults
                .filter((item: { url?: string; name?: string }) => item.url && item.name)
                .map((item: { url: string; name: string; snippet?: string; date?: string }) => ({
                  title: item.name.trim(),
                  url: item.url.trim(),
                  summary: snippetAsSummary && item.snippet ? item.snippet.trim().substring(0, 300) : '',
                  publishedAt: item.date || undefined,
                }));
              queryResults.push(items);
            } else {
              queryResults.push([]);
            }
          } catch (retryError) {
            if (signal?.aborted) throw retryError;
            console.error(`[websearch] Retry failed for "${query}"`);
            queryResults.push([]);
          }
        } else {
          console.error(`[websearch] Query "${query}" failed:`, errMsg);
          queryResults.push([]);
        }
      }
      // Delay between queries to avoid rate limiting
      if (queries.indexOf(query) < queries.length - 1) {
        await abortableDelay(1000, signal);
      }
    }

    // Merge and deduplicate by URL
    for (const items of queryResults) {
      for (const item of items) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          allItems.push(item);
        }
      }
    }

    if (allItems.length === 0) {
      return { success: false, items: [], error: 'No search results found' };
    }

    return { success: true, items: allItems };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    const msg = error instanceof Error ? error.message : 'Web search parse failed';
    return { success: false, items: [], error: msg };
  }
}

/**
 * Extract search queries from a URL label (fallback when queries not in config)
 */
function extractQueriesFromUrl(url: string): string[] {
  // If the URL looks like a search label, use it as query
  // e.g., "餐饮行业" -> ["餐饮行业新闻", "餐饮行业最新动态"]
  const label = url.replace(/^https?:\/\//, '').replace(/[/.]/g, ' ').trim();

  if (label.length > 0 && /[\u4e00-\u9fff]/.test(label)) {
    // Contains Chinese - use as base for queries
    return [`${label}新闻`, `${label}最新动态`];
  }

  // Default queries for industry news
  return [
    '餐饮行业新闻',
    '零售连锁品牌动态',
    '食品饮料行业资讯',
  ];
}
