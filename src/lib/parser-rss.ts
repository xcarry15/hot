import type { CrawlResult } from '@/contracts/crawl';
import { assertNotAborted } from './worker-stop';
import { ensureResponseTextWithinLimit } from './http';
import { resolveUrl } from './url-utils';
import { readZaiPage } from './zai-page-reader';

interface RssConfig {
  feedUrl?: string;
  maxItems?: number;
}

const DEFAULT_MAX_ITEMS = 20;
const MAX_ITEMS = 50;

function normalizeMaxItems(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(MAX_ITEMS, Math.floor(parsed)))
    : DEFAULT_MAX_ITEMS;
}

/**
 * RSS/Atom Parser
 * Uses page_reader to fetch the feed, then parses XML
 */
export async function parseRss(url: string, parserConfigStr: string, signal?: AbortSignal): Promise<CrawlResult> {
  try {
    const parsed: unknown = JSON.parse(parserConfigStr || '{}');
    const config: RssConfig = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as RssConfig
      : {};
    const feedUrl = typeof config.feedUrl === 'string' && config.feedUrl.trim()
      ? config.feedUrl.trim()
      : url;
    const maxItems = normalizeMaxItems(config.maxItems);

    const result = await readZaiPage(feedUrl, signal);
    assertNotAborted(signal);

    if (!result?.data?.html) {
      return { success: false, items: [], error: 'Failed to fetch RSS feed' };
    }

    const xml = ensureResponseTextWithinLimit(result.data.html);

    // Parse RSS items from XML
    const items = parseRssXml(xml, maxItems, feedUrl);

    return { success: true, items };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    const msg = error instanceof Error ? error.message : 'RSS parse failed';
    return { success: false, items: [], error: msg };
  }
}

function parseRssXml(xml: string, maxItems: number, baseUrl: string) {
  const items: Array<{
    title: string;
    url: string;
    summary?: string;
    publishedAt?: string;
  }> = [];

  // Try RSS 2.0 format: <item>...</item>
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && items.length < maxItems) {
    const itemXml = match[1];

    const title = extractTag(itemXml, 'title');
    const link = extractTag(itemXml, 'link');
    const description = extractTag(itemXml, 'description');
    const pubDate = extractTag(itemXml, 'pubDate');

    const url = link ? resolveUrl(link.trim(), baseUrl) : '';
    if (title && /^https?:\/\//iu.test(url)) {
      items.push({
        title: decodeEntities(title),
        url,
        summary: decodeEntities(description?.substring(0, 300) || ''),
        publishedAt: pubDate || undefined,
      });
    }
  }

  // Try Atom format: <entry>...</entry>
  if (items.length === 0) {
    const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    while ((match = entryRegex.exec(xml)) !== null && items.length < maxItems) {
      const entryXml = match[1];

      const title = extractTag(entryXml, 'title');
      const link =
        extractTagAttr(entryXml, 'link', 'href') || extractTag(entryXml, 'link');
      const summary =
        extractTag(entryXml, 'summary') || extractTag(entryXml, 'content');
      const updated = extractTag(entryXml, 'updated') || extractTag(entryXml, 'published');

      const url = link ? resolveUrl(link.trim(), baseUrl) : '';
      if (title && /^https?:\/\//iu.test(url)) {
        items.push({
          title: decodeEntities(title),
          url,
          summary: decodeEntities(summary?.substring(0, 300) || ''),
          publishedAt: updated || undefined,
        });
      }
    }
  }

  return items;
}

function extractTag(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

function extractTagAttr(xml: string, tagName: string, attrName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*${attrName}=["']([^"']*?)["']`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}
