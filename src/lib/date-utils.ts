/**
 * 日期解析工具 —— 中文日期 + HTML meta 标签时间提取。
 *
 * 历史：parseDateSafe 在 crawler.ts，extractPublishedAtFromHtml 在 detail-fetcher.ts，
 * parser-html.ts 内联日期正则。现统一收敛。
 */

import * as cheerio from 'cheerio';

/**
 * 解析中文日期格式："2026年06月02日" / "2026年06月02日 11:02" → Date。
 * 非法输入返回 undefined。
 */
export function parseChineseDate(value: string): Date | undefined {
  const normalized = value
    .replace(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/, '$1-$2-$3')
    .replace(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})?/, '$1-$2');
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return undefined;
  return d;
}

/**
 * 从文章详情页 HTML 提取精确发布时间。
 * 优先级：meta property > meta itemprop > meta name > LD+JSON > 可见元素选择器。
 * 提取不到返回 undefined。
 */
export function extractMetaPublishedAt(html: string): Date | undefined {
  const $ = cheerio.load(html);

  // --- Priority 1-4: Meta tags ---
  const metaSelectors = [
    'meta[property="article:published_time"]',
    'meta[itemprop="datePublished"]',
    'meta[name="pubdate"]',
    'meta[name="dc.date"]',
    'meta[name="dc.date.created"]',
  ];
  for (const sel of metaSelectors) {
    const content = $(sel).attr('content');
    if (content) {
      const d = new Date(content);
      if (!isNaN(d.getTime())) return d;
    }
  }

  // --- Priority 5: LD+JSON ---
  const ldScripts = $('script[type="application/ld+json"]').toArray();
  for (const el of ldScripts) {
    try {
      const data = JSON.parse($(el).text());
      const findDate = (obj: unknown): string | undefined => {
        if (!obj || typeof obj !== 'object') return undefined;
        if (Array.isArray(obj)) {
          for (const item of obj) {
            const r = findDate(item);
            if (r) return r;
          }
          return undefined;
        }
        const o = obj as Record<string, unknown>;
        if (o.datePublished && typeof o.datePublished === 'string') return o.datePublished;
        if (o.dateModified && typeof o.dateModified === 'string') return o.dateModified;
        for (const val of Object.values(o)) {
          const r = findDate(val);
          if (r) return r;
        }
        return undefined;
      };
      const dateStr = findDate(data);
      if (dateStr) {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) return d;
      }
    } catch {
      /* ignore malformed JSON */
    }
  }

  // --- Priority 6: Visible element selectors ---
  const selectorPatterns = [
    { selector: '.win-new-time .left', regex: /(\d{4}-\d{1,2}-\d{1,2}\s*\d{1,2}:\d{2})/ },
    { selector: '.article-time, .publish-time, .post-date, .entry-date, .time', regex: /(\d{4}-\d{1,2}-\d{1,2}\s*\d{1,2}:\d{2})/ },
  ];
  for (const { selector, regex } of selectorPatterns) {
    const text = $(selector).first().text().trim();
    if (text) {
      const match = text.match(regex);
      if (match) {
        const d = new Date(match[1]);
        if (!isNaN(d.getTime())) return d;
      }
    }
  }

  return undefined;
}
