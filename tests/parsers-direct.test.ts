import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  fetchHtml: vi.fn(),
  fetchHtmlDetailed: vi.fn(),
  fetchWithRetry: vi.fn(),
  getZAI: vi.fn(),
}));

vi.mock('@/lib/http', () => ({
  BROWSER_HEADERS: { 'User-Agent': 'test-browser' },
  fetchHtml: mocks.fetchHtml,
  fetchHtmlDetailed: mocks.fetchHtmlDetailed,
  fetchWithRetry: mocks.fetchWithRetry,
  MAX_RETRIES: 2,
  readResponseText: (response: { text: () => Promise<string> }) => response.text(),
  ensureResponseTextWithinLimit: (value: string) => value,
  hostFromUrl: (url: string) => new URL(url).origin,
  isLikelyJavaScriptVerificationPage: () => false,
  formatFetchDiagnostics: (diagnostics: Array<{
    method: string;
    transport?: string;
    status?: number | null;
    finalUrl?: string;
    error: string;
  }>) => diagnostics.map((item) => [
    `${item.method}${item.transport ? `/${item.transport}` : ''}`,
    item.status == null ? '' : `status=${item.status}`,
    item.finalUrl ? `finalUrl=${item.finalUrl}` : '',
    item.error,
  ].filter(Boolean).join(' ')).join(' | '),
  safeUrlForLog: (url: string) => url,
}));

vi.mock('@/lib/zai', () => ({
  getZAI: mocks.getZAI,
}));

import { parseHtml } from '@/lib/parser-html';
import { parseRss } from '@/lib/parser-rss';
import { parseCanyin88 } from '@/lib/parser-canyin88';

it('解析器和注册表只依赖 crawl 纯契约，不反向依赖 crawler', () => {
  const libDir = path.resolve(__dirname, '../src/lib');
  const parserFiles = [
    'parser-canyin88.ts',
    'parser-html.ts',
    'parser-registry.ts',
    'parser-rss.ts',
    'parser-websearch.ts',
  ];
  const violations = parserFiles.filter((fileName) => {
    const source = readFileSync(path.join(libDir, fileName), 'utf8');
    return /from ['"](?:\.\/crawler|@\/lib\/crawler)['"]/.test(source);
  });

  expect(violations).toEqual([]);
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchHtmlDetailed.mockImplementation(async (url: string, options: unknown) => {
    const html = await mocks.fetchHtml(url, options);
    return {
      html,
      status: html ? 200 : null,
      statusText: html ? 'OK' : '',
      finalUrl: url,
      transport: 'direct',
      ...(html ? {} : { error: 'mock failure' }),
    };
  });
});

describe('direct parser behavior', () => {
  it('upgrades Winshang article URLs to HTTPS', async () => {
    mocks.fetchHtml.mockImplementation(async (url: string) => (
      url.includes('/list')
        ? `
          <div class="winew-list">
            <li>
              <h3><a href="http://news.winshang.com/html/074/1861.html">赢商品牌动态测试文章</a></h3>
              <div class="win-new-info">品牌门店动态摘要</div>
              <div class="win-new-tab">2026-08-29</div>
            </li>
          </div>
        `
        : null
    ));

    const result = await parseHtml('https://news.winshang.com/list-12.html', JSON.stringify({
      listItem: '.winew-list li',
      link: 'h3 a',
      title: 'h3 a',
      summary: '.win-new-info',
      date: '.win-new-tab',
    }));

    expect(result.success).toBe(true);
    expect(result.items[0]?.url).toBe('https://news.winshang.com/html/074/1861.html');
  });

  it('保留 HTTP 状态、最终 URL、代理路径和 ZAI 失败原因', async () => {
    mocks.fetchHtmlDetailed.mockResolvedValue({
      html: null,
      status: 403,
      statusText: 'Forbidden',
      finalUrl: 'https://news.winshang.com/blocked',
      transport: 'proxy',
      error: 'HTTP 403 Forbidden',
    });
    mocks.getZAI.mockResolvedValue({
      functions: { invoke: vi.fn().mockRejectedValue(new Error('ZAI page_reader 429')) },
    });

    const result = await parseHtml('https://news.winshang.com/list-12.html', '{}');

    expect(result).toMatchObject({ success: false, items: [] });
    expect(result.error).toContain('http/proxy status=403 finalUrl=https://news.winshang.com/blocked');
    expect(result.error).toContain('zai ZAI page_reader 429');
  });

  it('parseHtml extracts structured list items with resolved URLs', async () => {
    mocks.fetchHtml.mockResolvedValue(`
      <main>
        <article class="news">
          <a class="link" href="/news/coffee">咖啡品牌开出新门店</a>
          <p class="summary">门店扩张摘要</p>
          <time>2026-07-09 10:30</time>
        </article>
      </main>
    `);

    const result = await parseHtml('https://example.com/list', JSON.stringify({
      listItem: '.news',
      link: '.link',
      title: '.link',
      summary: '.summary',
      date: 'time',
    }));

    expect(result.success).toBe(true);
    expect(result.items).toEqual([
      {
        title: '咖啡品牌开出新门店',
        url: 'https://example.com/news/coffee',
        summary: '门店扩张摘要',
        publishedAt: '2026-07-09 10:30',
      },
    ]);
  });

  it('parseHtml falls back to a compact date embedded in the article URL', async () => {
    mocks.fetchHtml.mockResolvedValue(`
      <main>
        <section class="news-item">
          <p class="title"><a href="/20260804/692331.shtml">亿邦动力文章</a></p>
          <p class="desc">文章摘要</p>
          <p class="date">刚刚</p>
        </section>
      </main>
    `);

    const result = await parseHtml('https://example.com/list', JSON.stringify({
      listItem: 'section.news-item',
      link: 'p.title a',
      title: 'p.title a',
      summary: 'p.desc',
    }));

    expect(result).toMatchObject({
      success: true,
      items: [{
        title: '亿邦动力文章',
        url: 'https://example.com/20260804/692331.shtml',
        summary: '文章摘要',
        publishedAt: '2026-08-04',
      }],
    });
  });

  it('parseRss reads RSS items, decodes entities, and respects maxItems', async () => {
    mocks.getZAI.mockResolvedValue({
      functions: {
        invoke: vi.fn().mockResolvedValue({
          data: {
            html: `
              <rss><channel>
                <item>
                  <title>瑞幸 &amp; 星巴克动态</title>
                  <link>https://example.com/a</link>
                  <description><![CDATA[行业摘要]]></description>
                  <pubDate>Thu, 09 Jul 2026 10:00:00 GMT</pubDate>
                </item>
                <item>
                  <title>第二条</title>
                  <link>https://example.com/b</link>
                </item>
              </channel></rss>
            `,
          },
        }),
      },
    });

    const result = await parseRss('https://example.com/feed.xml', JSON.stringify({ maxItems: 1 }));

    expect(result.success).toBe(true);
    expect(result.items).toEqual([
      {
        title: '瑞幸 & 星巴克动态',
        url: 'https://example.com/a',
        summary: '行业摘要',
        publishedAt: 'Thu, 09 Jul 2026 10:00:00 GMT',
      },
    ]);
  });

  it('parseRss resolves relative links against the actual feed URL', async () => {
    mocks.getZAI.mockResolvedValue({
      functions: {
        invoke: vi.fn().mockResolvedValue({
          data: { html: '<rss><channel><item><title>相对链接文章</title><link>/news/relative</link></item></channel></rss>' },
        }),
      },
    });

    const result = await parseRss('https://example.com/list', JSON.stringify({ feedUrl: 'https://feed.example.com/rss.xml' }));

    expect(result).toMatchObject({
      success: true,
      items: [{ title: '相对链接文章', url: 'https://feed.example.com/news/relative' }],
    });
  });

  it('parseCanyin88 extracts mobile post_item entries without detail fetches', async () => {
    const listHtml = `
      ${' '.repeat(600)}
      <div class="post_item" href="/zixun/123.html">
        <h3 class="post_h3">餐饮品牌发布加盟计划</h3>
        <span class="post_name chagePubdate">2026-07-09</span>
      </div>
    `;
    mocks.fetchWithRetry.mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(listHtml),
    });

    const result = await parseCanyin88('https://m.canyin88.com/zixun/');

    expect(result.success).toBe(true);
    expect(result.items).toEqual([
      {
        title: '餐饮品牌发布加盟计划',
        url: 'https://m.canyin88.com/zixun/123.html',
        summary: '',
        publishedAt: '2026-07-09',
      },
    ]);
    expect(mocks.fetchWithRetry).toHaveBeenCalledTimes(1);
  });
});
