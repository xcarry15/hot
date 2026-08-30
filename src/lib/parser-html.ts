import * as cheerio from 'cheerio';
import {
  ensureResponseTextWithinLimit,
  fetchHtmlDetailed,
  formatFetchDiagnostics,
  BROWSER_HEADERS,
  type FetchDiagnostic,
  isLikelyJavaScriptVerificationPage,
  safeUrlForLog,
} from './http';
import { resolveUrl } from './url-utils';
import { extractDateFromUrl, extractMetaPublishedAt } from './date-utils';
import type { CrawlResult } from '@/contracts/crawl';
import { assertNotAborted } from './worker-stop';
import { readZaiPage } from '@/lib/zai-page-reader';

interface HtmlConfig {
  listItem?: string;
  link?: string;
  title?: string;
  summary?: string;
  date?: string;
  content?: string;
  headers?: Record<string, string>;
  fetchDetailPublishedAt?: boolean;
}

const DIRECT_FETCH_TIMEOUT_MS = 20_000;
const DETAIL_DATE_FETCH_TIMEOUT_MS = 8_000;
const DETAIL_DATE_CONCURRENCY = 4;

function isWinshangUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'winshang.com' || hostname.endsWith('.winshang.com');
  } catch {
    return false;
  }
}

function normalizeWinshangUrl(url: string): string {
  return isWinshangUrl(url) ? url.replace(/^http:/i, 'https:') : url;
}

export async function parseHtml(url: string, parserConfigStr: string, signal?: AbortSignal): Promise<CrawlResult> {
  try {
    const config: HtmlConfig = JSON.parse(parserConfigStr || '{}');
    const customHeaders = config.headers || {};

    let html: string | null = null;
    let fetchMethod = '';
    let fetchTransport = '';
    const diagnostics: FetchDiagnostic[] = [];

    // Step 1: Try the shared HTTP path (直连或全局代理) with browser headers
    const directResult = await fetchHtmlDetailed(url, {
      signal,
      headers: { ...BROWSER_HEADERS, ...customHeaders, Referer: new URL(url).origin },
      timeoutMs: DIRECT_FETCH_TIMEOUT_MS,
    });
    html = directResult.html;
    if (html && !isLikelyJavaScriptVerificationPage(html)) {
      fetchMethod = 'http';
      fetchTransport = directResult.transport;
    } else {
      diagnostics.push({
        method: 'http',
        transport: directResult.transport,
        status: directResult.status,
        finalUrl: directResult.finalUrl,
        error: directResult.error
          || (html ? 'JavaScript verification page' : 'empty response'),
      });
      html = null;
    }

    // Step 2: Fall back to ZAI page_reader if direct fetch returned nothing
    if (!html) {
      try {
        const result = await readZaiPage(url, signal);
        html = result?.data?.html ? ensureResponseTextWithinLimit(result.data.html) : null;
        if (html) {
          fetchMethod = 'zai';
        } else {
          diagnostics.push({ method: 'zai', error: 'empty response' });
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        diagnostics.push({
          method: 'zai',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!html) {
      return {
        success: false,
        items: [],
        error: formatFetchDiagnostics(diagnostics) || 'HTML page returned no content',
      };
    }

    console.log(
      `[parser-html] ${safeUrlForLog(url)} fetched via ${fetchMethod}`
      + (fetchTransport ? `/${fetchTransport}` : '')
      + `, html_len=${html.length}`,
    );
    const items = extractLinksFromHtml(html, url, config).map((item) => ({
      ...item,
      url: normalizeWinshangUrl(item.url),
    }));
    return { success: true, items };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    const msg = error instanceof Error ? error.message : 'HTML parse failed';
    return { success: false, items: [], error: msg };
  }
}

function shouldFetchDetailPublishedAt(url: string, config: HtmlConfig): boolean {
  if (config.fetchDetailPublishedAt === true) return true;
  return isWinshangUrl(url);
}

export function sourceNeedsDetailPublishedAt(url: string, parserConfigStr: string): boolean {
  try {
    const config: HtmlConfig = JSON.parse(parserConfigStr || '{}');
    return shouldFetchDetailPublishedAt(url, config);
  } catch {
    return isWinshangUrl(url);
  }
}

async function fetchDetailHtml(
  url: string,
  signal?: AbortSignal,
): Promise<{ html: string | null; diagnostics: FetchDiagnostic[] }> {
  const headers = { ...BROWSER_HEADERS, Referer: new URL(url).origin };
  const diagnostics: FetchDiagnostic[] = [];
  const directResult = await fetchHtmlDetailed(url, {
    signal,
    headers,
    timeoutMs: DETAIL_DATE_FETCH_TIMEOUT_MS,
    // 这是可选的列表日期补全，不应叠加共享 HTTP 层的三次重试。
    retries: 0,
  });
  if (directResult.html && !isLikelyJavaScriptVerificationPage(directResult.html)) {
    return { html: directResult.html, diagnostics };
  }
  diagnostics.push({
    method: 'http',
    transport: directResult.transport,
    status: directResult.status,
    finalUrl: directResult.finalUrl,
    error: directResult.error
      || (directResult.html ? 'JavaScript verification page' : 'empty response'),
  });
  // 日期只是列表字段的补全，不值得为每个条目再启动一次 page_reader；
  // 正文阶段的新文章仍会按正式 HTTP → ZAI 兜底链路处理。
  return { html: null, diagnostics };
}

export async function enrichDetailPublishedAt(
  items: Array<{ title: string; url: string; summary?: string; publishedAt?: string }>,
  signal?: AbortSignal,
): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      assertNotAborted(signal);
      const item = items[nextIndex];
      nextIndex += 1;
      try {
        const detailResult = await fetchDetailHtml(item.url, signal);
        if (!detailResult.html) {
          console.warn(
            `[parser-html] detail publish date failed for ${safeUrlForLog(item.url)}: ${formatFetchDiagnostics(detailResult.diagnostics)}`,
          );
          continue;
        }
        const publishedAt = extractMetaPublishedAt(detailResult.html);
        if (publishedAt) item.publishedAt = publishedAt.toISOString();
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(
          `[parser-html] detail publish date failed for ${safeUrlForLog(item.url)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(DETAIL_DATE_CONCURRENCY, items.length) }, () => worker()),
  );
}

function extractLinksFromHtml(
  html: string,
  baseUrl: string,
  config: HtmlConfig
): Array<{ title: string; url: string; summary?: string; publishedAt?: string }> {
  if (config.listItem) {
    const structured = extractStructuredItems(html, baseUrl, config);
    if (structured.length > 0) return structured;
  }

  return extractAllLinks(html, baseUrl);
}

function extractStructuredItems(
  html: string,
  baseUrl: string,
  config: HtmlConfig
): Array<{ title: string; url: string; summary?: string; publishedAt?: string }> {
  const $ = cheerio.load(html);
  const items: Array<{ title: string; url: string; summary?: string; publishedAt?: string }> = [];

  $(config.listItem || '').each((_i, el) => {
    const $el = $(el);
    const item: { title: string; url: string; summary?: string; publishedAt?: string } = { title: '', url: '' };

    if (config.link) {
      const href = $el.find(config.link).attr('href') || $el.closest('a').attr('href');
      if (href) item.url = resolveUrl(href, baseUrl);
    }
    if (!item.url) {
      const $a = $el.find('a').first();
      const href = $a.attr('href');
      if (href) item.url = resolveUrl(href, baseUrl);
    }

    if (config.title) {
      const $title = $el.find(config.title).first();
      if ($title.length) item.title = $title.text().trim();
    }
    if (!item.title) {
      const $a = $el.find('a').first();
      if ($a.length) item.title = $a.text().trim();
    }

    if (config.summary) {
      const $summary = $el.find(config.summary).first();
      if ($summary.length) item.summary = $summary.text().trim().substring(0, 300);
    }

    if (config.date) {
      const $date = $el.find(config.date).first();
      if ($date.length) {
        const raw = $date.text().trim();
        const match = raw.match(/(\d{4})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})[日]?\s*(\d{1,2}:\d{2}(:\d{2})?)?/);
        item.publishedAt = match ? match[0] : raw.substring(0, 20);
      }
    }

    // 相对日期（如“刚刚”）无法持久化为 Date；文章 URL 中的 YYYYMMDD
    // 是稳定的来源事实，作为列表日期的兜底，确保未命中记录恢复后仍能
    // 在工作台最近文章窗口中按正常文章显示。
    const urlPublishedAt = extractDateFromUrl(item.url);
    if ((!item.publishedAt || !/\d{4}/.test(item.publishedAt)) && urlPublishedAt) {
      item.publishedAt = urlPublishedAt;
    }

    if (item.title && item.url) {
      items.push(item);
    }
  });

  return items;
}

function extractAllLinks(
  html: string,
  baseUrl: string
): Array<{ title: string; url: string; summary?: string; publishedAt?: string }> {
  const $ = cheerio.load(html);
  const items: Array<{ title: string; url: string; summary?: string; publishedAt?: string }> = [];
  const seen = new Set<string>();

  $('a').each((_i, el) => {
    const $a = $(el);
    const href = $a.attr('href');
    const text = $a.text().trim();

    if (!href || href === '/' || href === '#' || text.length < 4 || text.length > 120) return;

    const resolved = resolveUrl(href, baseUrl);
    if (!resolved.startsWith('http')) return;

    if (
      resolved.includes('javascript:') ||
      resolved.endsWith('.jpg') ||
      resolved.endsWith('.png') ||
      resolved.endsWith('.css') ||
      resolved.endsWith('.js') ||
      resolved.includes('login') ||
      resolved.includes('register')
    ) return;

    try {
      const baseDomain = new URL(baseUrl).hostname;
      const linkDomain = new URL(resolved).hostname;
      // 精确匹配或子域名后缀匹配，避免 includes 误判（如 bad-example.com 匹配 example.com）
      const isSameDomain = linkDomain === baseDomain || linkDomain.endsWith('.' + baseDomain);
      const isBaseSubdomainOfLink = baseDomain.endsWith('.' + linkDomain);
      if (!isSameDomain && !isBaseSubdomainOfLink) return;
    } catch {
      return;
    }

    if (seen.has(resolved)) return;
    seen.add(resolved);

    const publishedAt = extractDateFromUrl(resolved);
    items.push({
      title: text,
      url: resolved,
      ...(publishedAt ? { publishedAt } : {}),
    });
    if (items.length >= 20) return false;
  });

  return items;
}
