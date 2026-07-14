import type { CrawlItem, CrawlResult } from '@/contracts/crawl';
import { BROWSER_HEADERS, fetchWithRetry, hostFromUrl } from './http';
import { resolveUrl } from './url-utils';

/**
 * canyin88 专用 Parser (Mobile List Only — Detail lazy-loaded)
 *
 * 只抓列表页，提取标题+日期+URL，详情页在 AI 处理阶段按需获取
 * 大幅减少 HTTP 请求：从 11次 → 1次
 *
 * ⚠️ canyin88 使用原生 fetch + 正确的 Headers（含 Referer），
 * 不依赖 ZAI page_reader，避免 429 限流问题。
 *
 * 鲁棒性措施（共享自 src/lib/http.ts）：
 * - 完整浏览器请求头（Accept-Encoding、Sec-Fetch-* 等）
 * - fetchWithRetry：网络/超时/5xx/429 错误指数退避重试最多 3 次
 * - host 从列表页 URL 动态推断
 */

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CANYIN88_REFERER = 'https://www.canyin88.com/';

export async function parseCanyin88(baseUrl: string, signal?: AbortSignal): Promise<CrawlResult> {
  try {
    const listUrl = baseUrl || 'https://m.canyin88.com/zixun/';
    const detailHost = hostFromUrl(listUrl);

    // Step 1: Fetch the mobile list page
    let html: string;
    try {
      const response = await fetchWithRetry(listUrl, {
        signal,
        headers: {
          ...BROWSER_HEADERS,
          'User-Agent': MOBILE_UA,
          Referer: CANYIN88_REFERER,
        },
      });

      if (!response.ok) {
        return { success: false, items: [], error: `HTTP ${response.status} fetching list page` };
      }

      html = await response.text();
    } catch (fetchError: unknown) {
      if (signal?.aborted) throw fetchError;
      const msg = fetchError instanceof Error ? fetchError.message : 'Network error fetching list page';
      return { success: false, items: [], error: msg };
    }

    if (!html || html.length < 500) {
      return { success: false, items: [], error: 'Empty or too small response from list page' };
    }

    // Step 2: Parse structured post_item elements from mobile list
    const items: CrawlItem[] = [];
    const seen = new Set<string>();

    // Strategy: find all post_item divs by splitting on the pattern
    const postItemParts = html.split(/<div\s+class="post_item/);

    for (let i = 1; i < postItemParts.length; i++) {
      const part = postItemParts[i];

      // Extract href from the div attributes (the href is on the div itself now)
      const hrefMatch = part.match(/href="([^"]+)"/);
      if (!hrefMatch) continue;
      let href = hrefMatch[1];

      // Extract title from h3.post_h3
      const titleMatch = part.match(/<h3\s+class="post_h3"[^>]*>([\s\S]*?)<\/h3>/i);
      const title = titleMatch
        ? titleMatch[1].replace(/<[^>]*>/g, '').trim()
        : '';

      // Extract date from span.chagePubdate
      const dateMatch = part.match(/<span\s+class="post_name\s+chagePubdate"[^>]*>([\s\S]*?)<\/span>/i);
      const publishedAt = dateMatch
        ? dateMatch[1].replace(/<[^>]*>/g, '').trim()
        : undefined;

      if (!title || title.length < 4) continue;

      // Normalize URL: relative path → absolute using list page host
      href = resolveUrl(href, detailHost);
      if (!href.startsWith('http')) continue;

      // Dedup
      if (seen.has(href)) continue;
      seen.add(href);

      items.push({
        title,
        url: href,
        summary: '',
        publishedAt,
      });

      if (items.length >= 20) break;
    }

    // Fallback: if structured parsing found nothing, try broad <a> scanning
    if (items.length === 0) {
      const linkRegex = /<a[^>]+href=["']([^"']*?)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        let href = match[1];
        const linkText = match[2].replace(/<[^>]*>/g, '').trim();

        if (
          !href ||
          href === '/' ||
          href === '#' ||
          linkText.length < 4 ||
          linkText.length > 100
        ) {
          continue;
        }

        // Only canyin88 article URLs
        if (!href.includes('canyin88.com') && !href.startsWith('/')) continue;

        if (href.startsWith('/')) {
          href = resolveUrl(href, detailHost);
        }
        if (!href.startsWith('http')) continue;

        // Skip non-article links
        if (
          href.includes('javascript:') ||
          href.includes('login') ||
          href.includes('register') ||
          href.endsWith('.jpg') ||
          href.endsWith('.png') ||
          href.endsWith('.css') ||
          href.endsWith('.js')
        ) {
          continue;
        }

        if (seen.has(href)) continue;
        seen.add(href);

        items.push({
          title: linkText,
          url: href,
          summary: '',
        });

        if (items.length >= 20) break;
      }
    }

    if (items.length === 0) {
      return { success: false, items: [], error: 'No articles found on list page' };
    }

    return { success: true, items };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    const msg = error instanceof Error ? error.message : 'canyin88 parse failed';
    return { success: false, items: [], error: msg };
  }
}

/**
 * Fetch canyin88 detail page using native fetch with proper Referer header.
 * Uses the same retry+headers strategy as the list page.
 */
export async function fetchCanyin88Detail(url: string, signal?: AbortSignal): Promise<{ html: string } | null> {
  try {
    const response = await fetchWithRetry(url, {
      signal,
      headers: {
        ...BROWSER_HEADERS,
        'User-Agent': DESKTOP_UA,
        Referer: CANYIN88_REFERER,
      },
    });

    if (!response.ok) {
      console.error(`[fetchCanyin88Detail] HTTP ${response.status} for ${url}`);
      return null;
    }

    const html = await response.text();
    if (!html || html.length < 200) {
      console.error(`[fetchCanyin88Detail] Empty response for ${url}`);
      return null;
    }

    return { html };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[fetchCanyin88Detail] Failed for ${url}: ${msg}`);
    return null;
  }
}
