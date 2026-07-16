/**
 * 去重重构后的针对性测试（第一性原理版）
 *
 * 覆盖:
 * - m3: computeContentFingerprint 覆盖全文，避免前缀相同误判
 * - M4: getDedupConfig 模块级缓存（TTL + 失效 + per-source 覆盖 + 3 参数映射）
 * - M1: dedupBeforeAI（合并 L3+P0：pending↔pending + pending↔done，numeric 缓存 + 短文 LCS backstop）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocksHoisted = vi.hoisted(() => ({
  settingFindUnique: vi.fn(),
  sourceFindUnique: vi.fn(),
  articleFindMany: vi.fn(),
  articleUpdate: vi.fn(),
  articleFindUnique: vi.fn(),
  // detail-fetcher 依赖
  zaiInvoke: vi.fn(),
  canyin88FetchDetail: vi.fn(),
  httpFetchHtml: vi.fn(),
  cleanerCleanContent: vi.fn(),
  cleanerExtractArticleBody: vi.fn(),
  cleanerMeaningfulTextLength: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    setting: {
      findUnique: mocksHoisted.settingFindUnique,
    },
    source: {
      findUnique: mocksHoisted.sourceFindUnique,
    },
    article: {
      findMany: mocksHoisted.articleFindMany,
      update: mocksHoisted.articleUpdate,
      findUnique: mocksHoisted.articleFindUnique,
    },
  },
}));

// detail-fetcher 通过这些模块完成 HTTP 抓取。
// 在 D-FIX 块里按需设置实现；本文件其他测试不触碰这些模块，所以无副作用。
vi.mock('@/lib/zai', () => ({
  getZAI: vi.fn(async () => ({
    functions: { invoke: mocksHoisted.zaiInvoke },
  })),
}));

vi.mock('@/lib/parser-canyin88', () => ({
  fetchCanyin88Detail: mocksHoisted.canyin88FetchDetail,
}));

vi.mock('@/lib/http', () => ({
  fetchHtml: mocksHoisted.httpFetchHtml,
  BROWSER_HEADERS: {},
}));

vi.mock('@/lib/cleaner', () => ({
  cleanContent: mocksHoisted.cleanerCleanContent,
  extractArticleBody: mocksHoisted.cleanerExtractArticleBody,
  meaningfulTextLength: mocksHoisted.cleanerMeaningfulTextLength,
}));

vi.mock('@/lib/utils-shared', () => ({
  withTimeout: vi.fn(async (promise: Promise<unknown>) => promise),
  MIN_MEANINGFUL_CHARS: 80,
}));

import {
  computeContentFingerprint,
  getDedupConfig,
  _invalidateDedupConfig,
  dedupBeforeAI,
} from '../src/lib/dedup';
import { fetchArticleDetail } from '../src/lib/detail-fetcher';

// ================================================================
// m3: fingerprint 覆盖全文
// ================================================================
describe('m3: computeContentFingerprint 覆盖全文', () => {
  it('同 title + 同内容 → 相同指纹', () => {
    const f1 = computeContentFingerprint('测试标题', '内容'.repeat(500));
    const f2 = computeContentFingerprint('测试标题', '内容'.repeat(500));
    expect(f1).toBe(f2);
  });

  it('前 500 字相同但 500 字后不同 → 不同指纹（1000 窗口内可见差异）', () => {
    const base = 'a'.repeat(500);
    const f1 = computeContentFingerprint('T', base + '变化前');
    const f2 = computeContentFingerprint('T', base + '变化后');
    expect(f1).not.toBe(f2);
  });

  it('前 1000 字相同但之后不同 → 不同指纹', () => {
    const base = 'a'.repeat(1000);
    const f1 = computeContentFingerprint('T', base + 'X');
    const f2 = computeContentFingerprint('T', base + 'Y');
    expect(f1).not.toBe(f2);
  });

  it('前 1000 字内有差异 → 不同指纹', () => {
    const base = 'a'.repeat(1000);
    const f1 = computeContentFingerprint('T', 'X' + base.slice(1));
    const f2 = computeContentFingerprint('T', 'Y' + base.slice(1));
    expect(f1).not.toBe(f2);
  });

  it('短文不同内容 → 不同指纹', () => {
    expect(computeContentFingerprint('A', 'foo')).not.toBe(computeContentFingerprint('A', 'bar'));
  });

  it('空内容 → 不抛错，返回稳定哈希', () => {
    const f = computeContentFingerprint('T', '');
    expect(f).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ================================================================
// M4: getDedupConfig 模块级缓存 + 3 参数映射
// ================================================================
describe('M4: getDedupConfig 模块缓存 + 3 参数映射', () => {
  beforeEach(() => {
    mocksHoisted.settingFindUnique.mockReset();
    mocksHoisted.sourceFindUnique.mockReset();
    _invalidateDedupConfig();
  });

  it('第一次调用命中 DB，之后命中全局缓存', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: '' });

    await getDedupConfig();
    await getDedupConfig();
    await getDedupConfig();

    // 第一轮并发读取 6 个全局去重参数。
    expect(mocksHoisted.settingFindUnique).toHaveBeenCalledTimes(6);
  });

  it('sourceId 不再改变全局去重配置', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: '' });

    await getDedupConfig('s1');
    await getDedupConfig('s1');
    await getDedupConfig('s2');
    await getDedupConfig('s2');

    expect(mocksHoisted.settingFindUnique).toHaveBeenCalledTimes(6);
    expect(mocksHoisted.sourceFindUnique).not.toHaveBeenCalled();
  });

  it('_invalidateDedupConfig 强制下次重读', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: '' });

    await getDedupConfig();
    expect(mocksHoisted.settingFindUnique).toHaveBeenCalledTimes(6);
    _invalidateDedupConfig();
    await getDedupConfig();
    expect(mocksHoisted.settingFindUnique).toHaveBeenCalledTimes(12);
  });

  it('所有 setting key 读完后 clamp 到 DEDUP_LIMITS 默认值', async () => {
    // 所有 setting 返回空串 → 全部 clamp 到 DEDUP_LIMITS 默认
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: '' });

    const cfg = await getDedupConfig();
    expect(cfg.windowDays).toBe(15);
    expect(cfg.numericSharedMin).toBe(2);
    expect(cfg.bodyLcsMin).toBe(40);
    expect(cfg.lcsTotalMin).toBe(160);
    expect(cfg.brandGateEnabled).toBe(true);
    expect(cfg.shortBodyThreshold).toBe(1000);
  });

  it('DEDUP_BRAND_GATE_ENABLED="false" 关闭 brand gate', async () => {
    // 仅 brand_gate 字段返回 'false'，其他空串走默认
    mocksHoisted.settingFindUnique.mockImplementation(async (args: { where: { key: string } }) => {
      if (args.where.key === 'dedup_brand_gate_enabled') return { value: 'false' };
      return { value: '' };
    });

    const cfg = await getDedupConfig();
    expect(cfg.brandGateEnabled).toBe(false);
  });
});

// ================================================================
// M1: dedupBeforeAI（合并 L3 pending↔pending + P0 pending↔done）
// ================================================================
describe('M1: dedupBeforeAI（合并 L3+P0）', () => {
  beforeEach(() => {
    mocksHoisted.settingFindUnique.mockReset();
    mocksHoisted.articleFindMany.mockReset();
    mocksHoisted.articleUpdate.mockReset();
    _invalidateDedupConfig();
  });

  function makePendingArticle(overrides: Partial<{
    id: string;
    title: string;
    cleanContent: string;
    publishedAt: Date;
    createdAt: Date;
  }>) {
    return {
      id: 'a',
      title: 'T',
      cleanContent: '',
      publishedAt: new Date('2025-01-01'),
      createdAt: new Date('2025-01-01'),
      ...overrides,
    };
  }

  function makeDoneArticle(overrides: Partial<{
    id: string;
    title: string;
    cleanContent: string;
    publishedAt: Date;
  }>) {
    return {
      id: 'd1',
      title: 'DT',
      cleanContent: '',
      publishedAt: new Date('2025-01-01'),
      ...overrides,
    };
  }

  // dedupBeforeAI 调 findMany 两次：第一次 pending，第二次 done 候选
  function mockFindMany(pending: unknown[], done: unknown[] = []) {
    mocksHoisted.articleFindMany
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(done);
  }

  // 与 dedup.ts 内部 stripWs + stripLen 保持一致（去空格后取长度）
  const stripLenLocal = (s: string) => s.replace(/\s+/g, '').length;

  it('pending↔pending 数值强信号 + 正文证据 → 标重复', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: 'normal' });
    const sharedContent = '营收43.31亿元同比下滑12%净亏损2.39亿元。门店1646家。' +
      '报告同时披露经营效率、门店质量、区域布局与现金流管理等信息。'.repeat(5);
    mockFindMany([
      makePendingArticle({ id: 'a1', cleanContent: sharedContent, publishedAt: new Date('2025-01-01') }),
      makePendingArticle({ id: 'a2', cleanContent: sharedContent + '附加信息', publishedAt: new Date('2025-01-02') }),
    ]);
    mocksHoisted.articleUpdate.mockResolvedValue({});

    const result = await dedupBeforeAI();
    expect(result.skipped).toBe(1);
    expect(mocksHoisted.articleUpdate).toHaveBeenCalledTimes(1);
    expect(mocksHoisted.articleUpdate.mock.calls[0][0].data.aiStatus).toBe('skipped');
  });

  it('pending↔pending shared=0 + 短文 + 多段 LCS 总长 ≥ lcsTotalMin → LCS backstop 触发', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: '' });
    // 共享串 19 字符 × 12 次 = 228 字符，超过单段阈值 150 和总长阈值 200
    const longShared = '这是第一段内容包含一些随机字符用于去重测试'.repeat(12);
    expect(longShared.length).toBeGreaterThanOrEqual(200);
    const contentA = longShared + 'A端独特后缀';
    const contentB = longShared + 'B端独特后缀';
    expect(stripLenLocal(contentA)).toBeLessThan(1500); // 确认走短文兜底
    mockFindMany([
      makePendingArticle({ id: 'a1', cleanContent: contentA, publishedAt: new Date('2025-01-01') }),
      makePendingArticle({ id: 'a2', cleanContent: contentB, publishedAt: new Date('2025-01-02') }),
    ]);
    mocksHoisted.articleUpdate.mockResolvedValue({});

    const result = await dedupBeforeAI();
    expect(result.skipped).toBe(1);
    expect(mocksHoisted.articleUpdate).toHaveBeenCalledTimes(1);
  });

  it('pending↔pending shared=0 + 长文 + LCS 不跑 → 不标重复', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: 'normal' });
    const longShared = '这是一段用于构造长正文的描述性内容，刻意避免任何数字、品牌、地理位置或事件关键词出现'.repeat(50);
    const contentA = longShared + 'A端独特';
    const contentB = longShared + 'B端独特';
    expect(contentA.replace(/\s+/g, '').length).toBeGreaterThan(1500);
    mockFindMany([
      makePendingArticle({ id: 'a1', cleanContent: contentA, publishedAt: new Date('2025-01-01') }),
      makePendingArticle({ id: 'a2', cleanContent: contentB, publishedAt: new Date('2025-01-02') }),
    ]);
    mocksHoisted.articleUpdate.mockResolvedValue({});

    const result = await dedupBeforeAI();
    expect(result.skipped).toBe(0);
    expect(mocksHoisted.articleUpdate).not.toHaveBeenCalled();
  });

  it('pending↔pending borderline(shared=1 sameDay) + LCS≥80 → 标重复', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: 'normal' });
    const singleShared = '营收43.31亿';
    const filler = '市场反应良好，企业纷纷调整战略。';
    const longBody = singleShared + filler.repeat(20);
    const contentA = longBody + 'A端独特';
    const contentB = longBody + 'B端独特';
    mockFindMany([
      makePendingArticle({ id: 'a1', cleanContent: contentA, publishedAt: new Date('2025-06-15T08:00:00Z') }),
      makePendingArticle({ id: 'a2', cleanContent: contentB, publishedAt: new Date('2025-06-15T16:00:00Z') }),
    ]);
    mocksHoisted.articleUpdate.mockResolvedValue({});

    const result = await dedupBeforeAI();
    expect(result.skipped).toBe(1);
  });

  it('pending↔pending borderline(shared=1 sameDay) + LCS<80 → 不标重复', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: 'normal' });
    const singleShared = '营收43.31亿';
    const contentA = singleShared + 'A'.repeat(50);
    const contentB = singleShared + 'B'.repeat(50);
    mockFindMany([
      makePendingArticle({ id: 'a1', cleanContent: contentA, publishedAt: new Date('2025-06-15T08:00:00Z') }),
      makePendingArticle({ id: 'a2', cleanContent: contentB, publishedAt: new Date('2025-06-15T16:00:00Z') }),
    ]);
    mocksHoisted.articleUpdate.mockResolvedValue({});

    const result = await dedupBeforeAI();
    expect(result.skipped).toBe(0);
  });

  it('pending↔done 命中 → 标 pending 为 skipped（保留 done，省 AI 调用）', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: 'normal' });
    const sharedContent = '营收43.31亿元同比下滑12%净亏损2.39亿元门店1646家' +
      '报告同时披露经营效率、门店质量、区域布局与现金流管理等信息。'.repeat(5);
    mockFindMany(
      [makePendingArticle({ id: 'p1', title: '新pending', cleanContent: sharedContent, publishedAt: new Date('2025-01-02') })],
      [makeDoneArticle({ id: 'd1', title: '已完成', cleanContent: sharedContent + 'x', publishedAt: new Date('2025-01-01') })],
    );
    mocksHoisted.articleUpdate.mockResolvedValue({});

    const result = await dedupBeforeAI();
    expect(result.skipped).toBe(1);
    // 标的是 pending p1（保留 done d1）
    expect(mocksHoisted.articleUpdate.mock.calls[0][0].where.id).toBe('p1');
    expect(mocksHoisted.articleUpdate.mock.calls[0][0].data.aiStatus).toBe('skipped');
  });

  it('pending↔done 不命中 → 不标', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: 'normal' });
    mockFindMany(
      [makePendingArticle({ id: 'p1', cleanContent: '门店1646家营收43亿', publishedAt: new Date('2025-01-02') })],
      [makeDoneArticle({ id: 'd1', cleanContent: '完全不同的内容品牌发布会', publishedAt: new Date('2025-01-01') })],
    );
    mocksHoisted.articleUpdate.mockResolvedValue({});

    const result = await dedupBeforeAI();
    expect(result.skipped).toBe(0);
    expect(mocksHoisted.articleUpdate).not.toHaveBeenCalled();
  });

  it('publishedAt 超出 windowDays → 跳过该对', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: 'normal' });
    const sharedContent = '营收43.31亿元同比下滑12%净亏损2.39亿元门店1646家' +
      '报告同时披露经营效率、门店质量、区域布局与现金流管理等信息。'.repeat(5);
    mockFindMany([
      makePendingArticle({ id: 'a1', cleanContent: sharedContent, publishedAt: new Date('2025-01-01') }),
      makePendingArticle({ id: 'a2', cleanContent: sharedContent + 'x', publishedAt: new Date('2025-12-31') }),
    ]);
    mocksHoisted.articleUpdate.mockResolvedValue({});

    const result = await dedupBeforeAI();
    expect(result.skipped).toBe(0);
  });

  it('pending < 1 → 直接返回，不查 done 候选', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: 'normal' });
    mocksHoisted.articleFindMany.mockResolvedValueOnce([]);

    const result = await dedupBeforeAI();
    expect(result).toEqual({ checked: 0, skipped: 0 });
    expect(mocksHoisted.articleUpdate).not.toHaveBeenCalled();
    // 只调了一次 findMany（pending），没查 done
    expect(mocksHoisted.articleFindMany).toHaveBeenCalledTimes(1);
  });

  it('numeric 缓存：三篇同事件链式去重', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: 'normal' });
    const sharedContent = '营收43.31亿元同比下滑12%净亏损2.39亿元门店1646家' +
      '报告同时披露经营效率、门店质量、区域布局与现金流管理等信息。'.repeat(5);
    mockFindMany([
      makePendingArticle({ id: 'a1', cleanContent: sharedContent, publishedAt: new Date('2025-01-01') }),
      makePendingArticle({ id: 'a2', cleanContent: sharedContent, publishedAt: new Date('2025-01-02') }),
      makePendingArticle({ id: 'a3', cleanContent: sharedContent, publishedAt: new Date('2025-01-03') }),
    ]);
    mocksHoisted.articleUpdate.mockResolvedValue({});

    const result = await dedupBeforeAI();
    // a2 标为 a1 重复，a3 标为 a1 重复
    expect(result.skipped).toBe(2);
    expect(mocksHoisted.articleUpdate).toHaveBeenCalledTimes(2);
  });

  // ── null publishedAt 回退 createdAt（修复：源无日期文章曾整体绕过 before-AI 去重）──

  it('pending↔pending 均无 publishedAt → 回退 createdAt 仍去重', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: 'normal' });
    const sharedContent = '营收43.31亿元同比下滑12%净亏损2.39亿元门店1646家' +
      '报告同时披露经营效率、门店质量、区域布局与现金流管理等信息。'.repeat(5);
    mockFindMany([
      { id: 'a1', title: 'T1', cleanContent: sharedContent, publishedAt: null, createdAt: new Date('2025-01-01') },
      { id: 'a2', title: 'T2', cleanContent: sharedContent + 'x', publishedAt: null, createdAt: new Date('2025-01-02') },
    ]);
    mocksHoisted.articleUpdate.mockResolvedValue({});

    const result = await dedupBeforeAI();
    expect(result.skipped).toBe(1);
    // 保留 createdAt 更早的 a1，标记更晚的 a2
    expect(mocksHoisted.articleUpdate.mock.calls[0][0].where.id).toBe('a2');
  });

  it('pending 无 publishedAt vs done 无 publishedAt → 回退 createdAt 仍标 pending（省 AI）', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: 'normal' });
    const sharedContent = '营收43.31亿元同比下滑12%净亏损2.39亿元门店1646家' +
      '报告同时披露经营效率、门店质量、区域布局与现金流管理等信息。'.repeat(5);
    mockFindMany(
      [{ id: 'p1', title: '新pending', cleanContent: sharedContent, publishedAt: null, createdAt: new Date('2025-01-02') }],
      [{ id: 'd1', title: '已完成', cleanContent: sharedContent + 'x', publishedAt: null, createdAt: new Date('2025-01-01') }],
    );
    mocksHoisted.articleUpdate.mockResolvedValue({});

    const result = await dedupBeforeAI();
    expect(result.skipped).toBe(1);
    expect(mocksHoisted.articleUpdate.mock.calls[0][0].where.id).toBe('p1');
  });

  it('pending↔pending 一篇有 publishedAt 一篇无 → 按有效时间保留更老', async () => {
    mocksHoisted.settingFindUnique.mockResolvedValue({ value: 'normal' });
    const sharedContent = '营收43.31亿元同比下滑12%净亏损2.39亿元门店1646家' +
      '报告同时披露经营效率、门店质量、区域布局与现金流管理等信息。'.repeat(5);
    mockFindMany([
      // a1 无 publishedAt，createdAt 更早 → 应保留
      { id: 'a1', title: 'T1', cleanContent: sharedContent, publishedAt: null, createdAt: new Date('2025-01-01') },
      { id: 'a2', title: 'T2', cleanContent: sharedContent + 'x', publishedAt: new Date('2025-01-03'), createdAt: new Date('2025-01-03') },
    ]);
    mocksHoisted.articleUpdate.mockResolvedValue({});

    const result = await dedupBeforeAI();
    expect(result.skipped).toBe(1);
    expect(mocksHoisted.articleUpdate.mock.calls[0][0].where.id).toBe('a2');
  });
});

// ================================================================
// D-FIX: detail-fetcher 详情抓回后必须写 contentHash
//
// 历史 bug：detail-fetcher.ts 写入 cleanContent 后从不更新 contentHash，
// DB 里 contentHash 永远是采集阶段用列表页摘要算的（不可信）。
// 本块锁死修复行为。
// ================================================================

const ARTICLE_ID = 'art-dfix-001';
const ARTICLE_TITLE = '奈雪发布2026战略计划';
const ARTICLE_URL = 'https://example.com/news/naixue-2026';
const SAMPLE_CLEANED = '奈雪发布2026战略计划：计划新开300家门店聚焦一二线城市';
const SAMPLE_HTML = '<html><body><article>奈雪发布2026战略计划：计划新开300家门店聚焦一二线城市</article></body></html>';

describe('D-FIX: detail-fetcher writes contentHash', () => {
  beforeEach(() => {
    // detail-fetcher 内部走串行 for 循环 + maxRetries=2 默认参数；
    // beforeEach 重置所有相关 mock（dedupBeforeAI 的 mocksHoisted 仍共享，但本块单独覆盖）
    mocksHoisted.articleFindUnique.mockReset();
    mocksHoisted.articleUpdate.mockReset();
    mocksHoisted.httpFetchHtml.mockReset();
    mocksHoisted.zaiInvoke.mockReset();
    mocksHoisted.canyin88FetchDetail.mockReset();
    mocksHoisted.cleanerCleanContent.mockReset();
    mocksHoisted.cleanerExtractArticleBody.mockReset();
    mocksHoisted.cleanerMeaningfulTextLength.mockReset();
  });

  it('详情抓成功 → update data.contentHash 等于 computeContentFingerprint(title, cleaned)', async () => {
    // arrange
    mocksHoisted.articleFindUnique.mockResolvedValue({
      id: ARTICLE_ID,
      title: ARTICLE_TITLE,
      url: ARTICLE_URL,
      fetchStatus: 'pending',
      cleanContent: '',
      source: { type: 'rss' },
    });
    mocksHoisted.httpFetchHtml.mockResolvedValue(SAMPLE_HTML);
    mocksHoisted.cleanerExtractArticleBody.mockReturnValue(SAMPLE_HTML);
    mocksHoisted.cleanerCleanContent.mockReturnValue(SAMPLE_CLEANED);
    // meaningfulTextLength 返回 ≥ 80 → fetchStatus='fetched'
    mocksHoisted.cleanerMeaningfulTextLength.mockReturnValue(120);
    mocksHoisted.articleUpdate.mockResolvedValue({});

    // act: maxRetries=0 跳过 attempt 间的 setTimeout 退避延迟（默认 2 次重试会等 6 秒）
    const result = await fetchArticleDetail(ARTICLE_ID, /* maxRetries */ 0);

    // assert
    expect(result).toBe(SAMPLE_CLEANED);
    expect(mocksHoisted.articleUpdate).toHaveBeenCalledTimes(1);
    const updateData = mocksHoisted.articleUpdate.mock.calls[0][0].data;
    expect(updateData.contentHash).toBe(computeContentFingerprint(ARTICLE_TITLE, SAMPLE_CLEANED));
    expect(updateData.fetchStatus).toBe('fetched');
    expect(updateData.cleanContent).toBe(SAMPLE_CLEANED);
  });

  it('已 fetched + cleanContent 足够 → 早期返回，不调 update（contentHash 也不会被错写）', async () => {
    // arrange: 已经成功过的文章。cleanContent 必须 ≥ 80 字符才能触发早期返回
    // （detail-fetcher.ts:18 的检查是 fetchStatus='fetched' && cleanContent.length >= 80）
    const existingCleaned = '已经成功抓回的完整正文'.repeat(10); // 80+ 字符
    mocksHoisted.articleFindUnique.mockResolvedValue({
      id: ARTICLE_ID,
      title: ARTICLE_TITLE,
      url: ARTICLE_URL,
      fetchStatus: 'fetched',
      cleanContent: existingCleaned,
      source: { type: 'rss' },
    });

    // act
    const result = await fetchArticleDetail(ARTICLE_ID);

    // assert
    expect(result).toBe(existingCleaned);
    expect(mocksHoisted.articleUpdate).not.toHaveBeenCalled();
    expect(mocksHoisted.httpFetchHtml).not.toHaveBeenCalled();
  });

  it('fetchStatus=failed + cleanContent < 80 → 尝试重抓，所有重试失败后返回原 cleanContent', async () => {
    // arrange: 上次抓失败的 article，有效内容不足 80 字。
    // 新行为：不再永久放弃，允许重试；重试全部失败后返回现有内容（而非空串）。
    const prevCleaned = '部分抓取到的内容';
    mocksHoisted.articleFindUnique.mockResolvedValue({
      id: ARTICLE_ID,
      title: ARTICLE_TITLE,
      url: ARTICLE_URL,
      fetchStatus: 'failed',
      cleanContent: prevCleaned,
      source: { type: 'rss' },
    });
    mocksHoisted.httpFetchHtml.mockResolvedValue(null);
    mocksHoisted.zaiInvoke.mockRejectedValue(new Error('zai down'));

    // act
    const result = await fetchArticleDetail(ARTICLE_ID, 0);

    // assert: 重试全部失败后返回现有内容，而非空串
    expect(result).toBe(prevCleaned);
    expect(mocksHoisted.articleUpdate).toHaveBeenCalled();
  });

  it('所有重试都失败 → 最终 update 只写 fetchStatus=failed，不写 contentHash', async () => {
    // arrange: pending 文章但所有抓取方式都失败
    mocksHoisted.articleFindUnique.mockResolvedValue({
      id: ARTICLE_ID,
      title: ARTICLE_TITLE,
      url: ARTICLE_URL,
      fetchStatus: 'pending',
      cleanContent: '',
      source: { type: 'rss' },
    });
    mocksHoisted.httpFetchHtml.mockResolvedValue(null);
    mocksHoisted.zaiInvoke.mockRejectedValue(new Error('zai down'));
    mocksHoisted.canyin88FetchDetail.mockResolvedValue(null);

    // act
    const result = await fetchArticleDetail(ARTICLE_ID, /* maxRetries */ 0);

    // assert
    expect(result).toBe(''); // article.cleanContent || ''
    expect(mocksHoisted.articleUpdate).toHaveBeenCalledTimes(1);
    const updateData = mocksHoisted.articleUpdate.mock.calls[0][0].data;
    expect(updateData.fetchStatus).toBe('failed');
    // 失败路径绝对不能写 contentHash —— 全文没拿到，hash 不应被错误地标为"成功计算"
    expect(updateData.contentHash).toBeUndefined();
  });
});
