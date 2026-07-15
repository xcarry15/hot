import * as cheerio from 'cheerio';
import { getZAI } from './zai';
import { fetchHtml, BROWSER_HEADERS } from './http';
import { resolveUrl } from './url-utils';
import { extractMetaPublishedAt } from './date-utils';
import type { CrawlResult } from '@/contracts/crawl';
import { assertNotAborted } from './worker-stop';

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
const DETAIL_DATE_CONCURRENCY = 4;

export async function parseHtml(url: string, parserConfigStr: string, signal?: AbortSignal): Promise<CrawlResult> {
  try {
    const config: HtmlConfig = JSON.parse(parserConfigStr || '{}');
    const customHeaders = config.headers || {};

    let html: string | null = null;
    let fetchMethod = '';

    // Step 1: Try direct fetch with browser headers and charset detection
    html = await fetchHtml(url, {
      signal,
      headers: { ...BROWSER_HEADERS, ...customHeaders, Referer: new URL(url).origin },
      timeoutMs: DIRECT_FETCH_TIMEOUT_MS,
    });
    if (html) fetchMethod = 'direct';

    // Step 2: Fall back to ZAI page_reader if direct fetch returned nothing
    if (!html) {
      try {
        const zai = await getZAI();
        const result = await zai.functions.invoke('page_reader', { url });
        assertNotAborted(signal);
        html = result?.data?.html || null;
        if (html) fetchMethod = 'zai';
      } catch (error) {
        if (signal?.aborted) throw error;
        // Both methods failed
      }
    }

    if (!html) {
      return { success: false, items: [], error: 'Failed to fetch HTML page (direct + ZAI both failed)' };
    }

    console.log(`[parser-html] ${url} fetched via ${fetchMethod}, html_len=${html.length}`);
    const items = extractLinksFromHtml(html, url, config);
    if (shouldFetchDetailPublishedAt(url, config) && items.length > 0) {
      await enrichDetailPublishedAt(items, signal);
    }

    return { success: true, items };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    const msg = error instanceof Error ? error.message : 'HTML parse failed';
    return { success: false, items: [], error: msg };
  }
}

function shouldFetchDetailPublishedAt(url: string, config: HtmlConfig): boolean {
  if (config.fetchDetailPublishedAt === true) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'winshang.com' || hostname.endsWith('.winshang.com');
  } catch {
    return false;
  }
}

async function fetchDetailHtml(url: string, signal?: AbortSignal): Promise<string | null> {
  const headers = { ...BROWSER_HEADERS, Referer: new URL(url).origin };
  const directHtml = await fetchHtml(url, {
    signal,
    headers,
    timeoutMs: DIRECT_FETCH_TIMEOUT_MS,
  });
  if (directHtml) return directHtml;

  try {
    const zai = await getZAI();
    const result = await zai.functions.invoke('page_reader', { url });
    assertNotAborted(signal);
    return result?.data?.html || null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function enrichDetailPublishedAt(
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
        const detailHtml = await fetchDetailHtml(item.url, signal);
        if (!detailHtml) continue;
        const publishedAt = extractMetaPublishedAt(detailHtml);
        if (publishedAt) item.publishedAt = publishedAt.toISOString();
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(`[parser-html] detail publish date failed for ${item.url}`);
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

    items.push({ title: text, url: resolved });
    if (items.length >= 20) return false;
  });

  return items;
}
