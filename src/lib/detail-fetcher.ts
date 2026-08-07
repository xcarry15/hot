import * as cheerio from 'cheerio';
import { db } from './db';
import { getZAI } from './zai';
import { fetchCanyin88Detail } from './parser-canyin88';
import { cleanContent, extractArticleBody, meaningfulTextLength } from './cleaner';
import { abortableDelay, withTimeout } from './shared/async';
import { MIN_MEANINGFUL_CHARS } from './shared/content-policy';
import {
  ensureResponseTextWithinLimit,
  fetchHtml,
  BROWSER_HEADERS,
  isLikelyJavaScriptVerificationPage,
} from './http';
import { assertSafeOutboundUrl } from './outbound-url';
import { extractMetaPublishedAt } from './date-utils';
import { computeContentFingerprint } from './content-fingerprint';
import { assertNotAborted } from './worker-stop';

const PAGE_READER_TIMEOUT_MS = 30000;
const DIRECT_FETCH_TIMEOUT_MS = 20000;
export const FETCH_MAX_RETRIES = 5;
export const FETCH_RETRY_DELAY_MS = 2 * 60 * 60 * 1000;

/**
 * 将未完成的正文抓取收口为可恢复失败。
 *
 * `withTimeout` 会中止请求，但底层操作可能在极端情况下晚于调用方返回；
 * 因此批处理超时只能在文章仍为 pending 时写入，不能覆盖随后已成功的抓取。
 */
export async function markArticleFetchFailure(
  articleId: string,
  error: unknown,
  options: { onlyIfPending?: boolean } = {},
): Promise<boolean> {
  const latest = await db.article.findUnique({
    where: { id: articleId },
    select: { fetchRetryCount: true, fetchStatus: true },
  });
  if (!latest || (options.onlyIfPending && latest.fetchStatus !== 'pending')) return false;

  const retryCount = latest.fetchRetryCount + 1;
  const result = await db.article.updateMany({
    where: {
      id: articleId,
      ...(options.onlyIfPending ? { fetchStatus: 'pending' } : {}),
    },
    data: {
      fetchStatus: 'failed',
      fetchError: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      fetchRetryCount: retryCount,
      nextFetchRetryAt: retryCount >= FETCH_MAX_RETRIES
        ? null
        : new Date(Date.now() + FETCH_RETRY_DELAY_MS),
    },
  });
  return result.count === 1;
}

function extractLinkshopOriginalSource(html: string): string | null {
  const $ = cheerio.load(html);
  const authorText = $('span.author').first().text().trim();
  if (!authorText) return null;
  const parts = authorText.split(/\s+/);
  const source = parts[0] || '';
  return source || null;
}

function extractArticleBodyForSource(html: string, parserConfig?: string): string {
  if (parserConfig) {
    try {
      const parsed: unknown = JSON.parse(parserConfig);
      const contentSelector = parsed
        && typeof parsed === 'object'
        && !Array.isArray(parsed)
        && typeof (parsed as { content?: unknown }).content === 'string'
        ? (parsed as { content: string }).content.trim()
        : '';
      if (contentSelector) {
        const selected = cheerio.load(html)(contentSelector).first().html();
        if (selected && selected.length > 100) return selected;
      }
    } catch {
      // 来源配置错误时回退通用正文提取，不能中断正文流水线。
    }
  }
  return extractArticleBody(html);
}

function hasUsableArticleContent(html: string, parserConfig?: string): boolean {
  const articleBody = extractArticleBodyForSource(html, parserConfig);
  return meaningfulTextLength(cleanContent(articleBody)) >= MIN_MEANINGFUL_CHARS;
}

export async function fetchArticleDetail(articleId: string, maxRetries = 2, signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal);
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      url: true,
      title: true,
      fetchStatus: true,
      cleanContent: true,
      originalSource: true,
      source: { select: { type: true, parserConfig: true } },
    },
  });
  if (!article) return '';
  if (article.fetchStatus === 'fetched' && (article.cleanContent?.length ?? 0) >= MIN_MEANINGFUL_CHARS) return article.cleanContent;
  if (article.fetchStatus === 'failed') {
    // 即使失败，如果之前已抓到有效内容也直接返回，不重新抓取
    if ((article.cleanContent?.length ?? 0) >= MIN_MEANINGFUL_CHARS) return article.cleanContent;
    // 无有效内容，允许重试（由调用方控制退避，这里不做判断）
  }

  const isCanyin88 = article.source?.type === 'canyin88' || article.url.includes('canyin88.com');
  let lastError: Error | null = null;
  let pageReaderTimedOut = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      assertNotAborted(signal);
      if (attempt > 0) {
        const delay = Math.pow(2, attempt) * 1000;
        await abortableDelay(delay, signal);
      }

      let html: string | null = null;
      let fetchMethod = '';

      if (isCanyin88) {
        const detailResult = await fetchCanyin88Detail(article.url, signal);
        html = detailResult?.html || null;
        fetchMethod = 'canyin88';
      } else {
        // Step 1: Try direct HTTP fetch with charset detection
        const directHtml = await fetchHtml(article.url, {
          signal,
          headers: { ...BROWSER_HEADERS, Referer: new URL(article.url).origin },
          timeoutMs: DIRECT_FETCH_TIMEOUT_MS,
        });
        // 某些站点会返回 HTTP 200 的 JS 验证页或空壳页面。它们不是有效正文，
        // 必须继续走 page_reader，不能因 html 非空而提前停止兜底。
        if (
          directHtml
          && !isLikelyJavaScriptVerificationPage(directHtml)
          && hasUsableArticleContent(directHtml, article.source?.parserConfig)
        ) {
          html = directHtml;
          fetchMethod = 'direct';
        }

        // Step 2: Fall back to ZAI page_reader if direct returned no usable article body.
        if (!html && !pageReaderTimedOut) {
          try {
            await assertSafeOutboundUrl(article.url);
            const zai = await getZAI();
            const pageResult = await withTimeout(
              async timeoutSignal => {
                const value = await zai.functions.invoke('page_reader', { url: article.url });
                assertNotAborted(timeoutSignal);
                return value;
              },
              PAGE_READER_TIMEOUT_MS,
              `ZAI page_reader timeout: ${article.url}`,
              signal,
            );
            html = pageResult?.data?.html ? ensureResponseTextWithinLimit(pageResult.data.html) : null;
            if (html) fetchMethod = 'zai';
          } catch (error) {
            if (signal?.aborted) throw error;
            if (error instanceof Error && error.message.includes('ZAI page_reader timeout')) {
              // 当前 ZAI SDK 没有 AbortSignal 接口。超时只会中止本地等待，
              // 若立刻重试会让同一文章挂起多个远程 page_reader 调用。
              pageReaderTimedOut = true;
            }
            // Both methods failed
          }
        }
      }

      if (html) {
        assertNotAborted(signal);
        const articleBody = extractArticleBodyForSource(html, article.source?.parserConfig);
        const cleaned = cleanContent(articleBody);
        const meaningful = meaningfulTextLength(cleaned) >= MIN_MEANINGFUL_CHARS;

        // Try to extract a more precise publishedAt from detail page meta tags
        const detailPublishedAt = extractMetaPublishedAt(html);

        // Extract original source for linkshop articles
        const isLinkshop = article.url.includes('linkshop.com');
        const originalSourceData = !article.originalSource && isLinkshop
          ? { originalSource: extractLinkshopOriginalSource(html) }
          : {};

        assertNotAborted(signal);
        await db.article.update({
          where: { id: articleId },
          data: {
            rawContent: html,
            cleanContent: cleaned,
            articleBody,
            // 详情抓回后用全文重算指纹（采集阶段算的是列表页摘要，旧 hash 不可信）。
            // 内容指纹是事件聚类的强证据；详情正文变化时必须同步更新。
            contentHash: computeContentFingerprint(article.title, cleaned),
            fetchStatus: meaningful ? 'fetched' : 'failed',
            ...(meaningful ? { fetchRetryCount: 0, nextFetchRetryAt: null, fetchError: null, technicalIgnoredAt: null } : {}),
            ...(detailPublishedAt ? { publishedAt: detailPublishedAt } : {}),
            ...originalSourceData,
          },
        });

        console.log(`[fetchArticleDetail] article=${articleId} content_len=${cleaned.length} meaningful=${meaningful} attempt=${attempt} via=${fetchMethod}${detailPublishedAt ? ` detailDate=${detailPublishedAt.toISOString()}` : ''}`);
        if (meaningful) return cleaned;
        lastError = new Error(`正文内容不足（有效文本 ${meaningfulTextLength(cleaned)} 字）`);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[fetchArticleDetail] article=${articleId} attempt=${attempt} error:`, lastError.message);
    }
  }

  console.error(`[fetchArticleDetail] article=${articleId} all ${maxRetries + 1} attempts failed:`, lastError?.message);
  assertNotAborted(signal);
  await markArticleFetchFailure(articleId, lastError ?? new Error('未获取到有效正文'));

  // 失败时不能把旧的短正文当作本次抓取成功的结果返回。
  // 否则单篇重跑会继续进入 AI / 聚类，批处理也可能把失败文章计为已处理。
  return '';
}
