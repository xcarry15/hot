import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { DEFAULT_EXPORT_FILTER } from '@/contracts/data-export';
import { buildExportWorkbook } from '@/lib/export/export-workbook';

const snapshotAt = new Date('2026-08-07T00:00:00.000Z');

describe('Excel 导出工作簿', () => {
  it('只生成白名单工作表并保留中文列、长度语义和敏感信息脱敏', async () => {
    let articleRead = false;
    const source = {
      id: 'source-1',
      name: '测试来源',
      type: 'html',
      url: 'https://example.com/feed?token=source-secret',
      parserConfig: JSON.stringify({ headers: { Authorization: 'Bearer source-secret' } }),
      enabled: true,
      publicEnabled: true,
      status: 'normal',
      consecutiveFailures: 0,
      circuitBreakerUntil: null,
      lastFetchedAt: snapshotAt,
      createdAt: snapshotAt,
      updatedAt: snapshotAt,
      deletedAt: null,
    };
    const event = {
      id: 'event-1',
      status: 'active',
      clusterReviewStatus: 'confirmed',
      mergedIntoId: null,
      representativeArticleId: 'article-1',
      representativeManual: true,
      firstSeenAt: snapshotAt,
      lastSeenAt: snapshotAt,
      articleCount: 1,
      publicStatus: 'published',
      publicPublishedAt: snapshotAt,
      publicRevokedAt: null,
      publicDateKey: '2026-08-07',
      publicSortAt: snapshotAt,
      pushedAt: snapshotAt,
      viewCount: 3,
      originalClickCount: 1,
      nextPushRetryAt: null,
      pushRetryCount: 0,
      createdAt: snapshotAt,
      updatedAt: snapshotAt,
    };
    const article = {
      id: 'article-1',
      sourceId: source.id,
      url: 'https://example.com/article?id=1&token=article-secret',
      title: '测试文章',
      originalSource: '测试媒体',
      rawContent: '原文内容',
      cleanContent: '清洗内容',
      contentHash: 'hash',
      eventId: event.id,
      clusterStatus: 'clustered',
      clusteredAt: snapshotAt,
      clusterError: null,
      clusterRetryCount: 0,
      nextClusterRetryAt: null,
      eventSubjects: '["测试品牌"]',
      eventAction: '发布',
      eventObject: '新品',
      eventKey: '测试品牌|发布|新品',
      eventKeyConfidence: 95,
      fetchStatus: 'fetched',
      fetchError: null,
      fetchRetryCount: 0,
      nextFetchRetryAt: null,
      technicalIgnoredAt: null,
      articleBody: '正文内容',
      relevance: 90,
      summary: '摘要'.repeat(20_000),
      brand: '测试品牌',
      category: '品牌',
      keyPoints: '["关键点"]',
      score: 88,
      keywordMatched: true,
      eventScore: 90,
      contentScore: 86,
      rawScore: 82,
      adProbability: 2,
      aiConfidence: 93,
      scorePolicyVersion: 'v1',
      aiModel: 'test-model',
      aiProvider: 'test-provider',
      promptHash: 'prompt-hash',
      scorePolicySnapshot: '{}',
      promptVersion: 'v1',
      aiStatus: 'done',
      aiError: null,
      aiSnapshot: '{}',
      manualOverrides: '[]',
      manualCorrectedAt: null,
      skipReason: null,
      aiRetryCount: 0,
      nextAiRetryAt: null,
      isAd: false,
      publicOverride: 'auto',
      publicStatus: 'published',
      publicPublishedAt: snapshotAt,
      publicRevokedAt: null,
      publicPublicationReason: '',
      publicPublicationEvaluatedAt: snapshotAt,
      publicContentUpdatedAt: snapshotAt,
      viewCount: 3,
      originalClickCount: 1,
      publishedAt: snapshotAt,
      createdAt: snapshotAt,
      updatedAt: snapshotAt,
      source,
      searchIndex: { articleId: 'article-1', searchText: '测试文章 原文内容', updatedAt: snapshotAt },
      event: {
        id: event.id,
        status: event.status,
        clusterReviewStatus: event.clusterReviewStatus,
        publicStatus: event.publicStatus,
        representativeArticleId: event.representativeArticleId,
        representativeManual: event.representativeManual,
        articleCount: event.articleCount,
        mergedIntoId: event.mergedIntoId,
        pushedAt: event.pushedAt,
      },
      representedEvent: { id: event.id, representativeManual: true },
      keywordHits: [{
        articleId: 'article-1',
        keywordId: 'keyword-1',
        createdAt: snapshotAt,
        keyword: { id: 'keyword-1', category: 'brand', word: '测试品牌', createdAt: snapshotAt },
      }],
    };
    const emptyModel = { count: async () => 0, findMany: async () => [] };
    const fakeDb = {
      article: {
        count: async () => 1,
        findMany: async () => {
          if (articleRead) return [];
          articleRead = true;
          return [article];
        },
      },
      discardedItem: emptyModel,
      source: { findMany: async () => [source] },
      fetchLog: emptyModel,
      keyword: emptyModel,
      keywordCandidate: emptyModel,
      pushLog: emptyModel,
    } as unknown as Parameters<typeof buildExportWorkbook>[0];

    const result = await buildExportWorkbook(fakeDb, DEFAULT_EXPORT_FILTER, snapshotAt, undefined, {
      exportJobId: 'export-1',
      applicationVersion: 'test',
      exportStartedAt: snapshotAt,
    });
    const workbook = XLSX.read(result.buffer, { cellDates: true });
    const rawWorkbook = XLSX.read(result.buffer, { cellDates: false });
    const articles = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets['文章数据'], { defval: '' });
    const articleHeaders = XLSX.utils.sheet_to_json(workbook.Sheets['文章数据'], { header: 1, defval: '' })[0] as unknown[];
    const sources = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets['数据源'], { defval: '' });
    const meta = XLSX.utils.sheet_to_json(workbook.Sheets['导出元数据'], { header: 1, defval: '' }) as unknown[][];

    expect(articles[0]).toMatchObject({
      '文章 ID': 'article-1',
      来源类型: 'html',
      来源是否启用: true,
      来源是否公开启用: true,
      来源健康状态说明: '正常',
      '原始抓取内容长度（含 HTML）': 4,
      '提取正文 HTML 长度（含标签）': 4,
      '清洗后保留文本长度': 4,
      '事件聚类复核状态说明': '已确认',
      '事件公开状态说明': '已公开',
      '事件代表文章 ID': 'article-1',
      事件代表文章选择方式: '人工选择',
      事件文章数量: 1,
      '聚类状态（原值）': 'clustered',
      聚类状态说明: '已聚类',
      抓取状态说明: '已抓取',
      'AI 状态说明': '已完成',
      公开状态说明: '已公开',
      当前处理结论: '已公开并已推送',
      是否需要人工处理: false,
      处理阻断原因: '',
      原始评分: 82,
      综合评分: 88,
      实际命中关键词: '测试品牌',
      '命中关键词 ID': '["keyword-1"]',
      事件状态说明: '有效',
      链接: 'https://example.com/article?id=1',
    });
    const searchColumnStart = articleHeaders.indexOf('标题');
    expect(articleHeaders.slice(searchColumnStart, searchColumnStart + 4)).toEqual(['标题', '摘要', '品牌/主体', '事件标识']);
    expect(articleHeaders).not.toContain('搜索文本');
    expect(articleHeaders.indexOf('原始评分')).toBe(articleHeaders.indexOf('综合评分') - 1);
    expect(String(articles[0].摘要)).toContain('...[超过 Excel 单元格上限，已截断]');
    const publishedAtCell = rawWorkbook.Sheets['文章数据'][XLSX.utils.encode_cell({
      r: 1,
      c: articleHeaders.indexOf('发布时间'),
    })] as { t?: string; v?: unknown; w?: string };
    expect(publishedAtCell.t).toBe('n');
    expect(publishedAtCell.w).toBe('2026-08-07 08:00:00');
    expect(sources[0]).toMatchObject({
      链接: 'https://example.com/feed',
      '解析配置（已脱敏 JSON）': '{"headers":{"Authorization":"[REDACTED]"}}',
      状态说明: '正常',
    });
    expect(workbook.SheetNames).toEqual([
      '导出元数据',
      '数据源',
      '文章数据',
      '未入库条目',
      '关键词',
      '候选关键词',
      '抓取日志 ID',
      '推送日志',
    ]);
    expect(workbook.SheetNames).not.toContain('文章正文');
    expect(workbook.SheetNames).not.toContain('长文本分片');
    expect(meta.some((row) => row[0] === '导出任务 ID' && row[1] === 'export-1')).toBe(true);
    expect(meta.some((row) => row[0] === '导出格式版本' && row[1] === 4)).toBe(true);
    expect(meta.some((row) => row[0] === '错误数量' && row[1] === 0)).toBe(true);
    expect(meta.some((row) => String(row[0]).includes('ISO'))).toBe(false);
  });
});
