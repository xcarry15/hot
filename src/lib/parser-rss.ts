import { getZAI } from './zai';
import type { CrawlResult } from '@/contracts/crawl';
import { assertNotAborted } from './worker-stop';

interface RssConfig {
  feedUrl?: string;
  maxItems?: number;
}

/**
 * RSS/Atom Parser
 * Uses page_reader to fetch the feed, then parses XML
 */
export async function parseRss(url: string, parserConfigStr: string, signal?: AbortSignal): Promise<CrawlResult> {
  try {
    const config: RssConfig = JSON.parse(parserConfigStr || '{}');
    const feedUrl = config.feedUrl || url;
    const maxItems = config.maxItems || 20;

    const zai = await getZAI();
    const result = await zai.functions.invoke('page_reader', {
      url: feedUrl,
    });
    assertNotAborted(signal);

    if (!result?.data?.html) {
      return { success: false, items: [], error: 'Failed to fetch RSS feed' };
    }

    const xml = result.data.html;

    // Parse RSS items from XML
    const items = parseRssXml(xml, maxItems);

    return { success: true, items };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    const msg = error instanceof Error ? error.message : 'RSS parse failed';
    return { success: false, items: [], error: msg };
  }
}

function parseRssXml(xml: string, maxItems: number) {
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

    if (title && link) {
      items.push({
        title: decodeEntities(title),
        url: link.trim(),
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

      if (title && link) {
        items.push({
          title: decodeEntities(title),
          url: link.trim(),
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
