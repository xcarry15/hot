import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  fetchHtml: vi.fn(),
  fetchWithRetry: vi.fn(),
  getZAI: vi.fn(),
}));

vi.mock('@/lib/http', () => ({
  BROWSER_HEADERS: { 'User-Agent': 'test-browser' },
  fetchHtml: mocks.fetchHtml,
  fetchWithRetry: mocks.fetchWithRetry,
  hostFromUrl: (url: string) => new URL(url).origin,
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
});

describe('direct parser behavior', () => {
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
