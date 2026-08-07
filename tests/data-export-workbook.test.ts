import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { DEFAULT_EXPORT_FILTER } from '@/contracts/data-export';
import { buildExportWorkbook } from '@/lib/export/export-workbook';

const snapshotAt = new Date('2026-08-07T00:00:00.000Z');

describe('Excel 导出工作簿', () => {
  it('保留文章正文、状态中文列、关联关系和敏感信息脱敏', async () => {
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
      rawScore: 88,
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
      event: { id: event.id, status: event.status, pushedAt: event.pushedAt },
      representedEvent: { id: event.id, representativeManual: true },
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
      event: { findMany: async () => [event] },
      eventDirty: emptyModel,
      eventClusterAudit: emptyModel,
      source: { findMany: async () => [source] },
      fetchLog: emptyModel,
      job: emptyModel,
      keywordHit: emptyModel,
      keyword: emptyModel,
      keywordCandidate: emptyModel,
      tuningSuggestion: emptyModel,
      discardedRetryAudit: emptyModel,
      pushDelivery: emptyModel,
      pushLog: emptyModel,
      pushTarget: emptyModel,
      eventInteractionDaily: emptyModel,
    } as unknown as Parameters<typeof buildExportWorkbook>[0];

    const result = await buildExportWorkbook(fakeDb, DEFAULT_EXPORT_FILTER, snapshotAt, undefined, {
      exportJobId: 'export-1',
      applicationVersion: 'test',
      exportStartedAt: snapshotAt,
    });
    const workbook = XLSX.read(result.buffer, { cellDates: true });
    const articles = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Articles, { defval: '' });
    const relations = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.ArticleEventRelations, { defval: '' });
    const content = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.ArticleContent, { defval: '' });
    const sources = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Sources, { defval: '' });
    const longText = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.LongTextChunks, { defval: '' });
    const meta = XLSX.utils.sheet_to_json(workbook.Sheets.ExportMeta, { header: 1, defval: '' }) as unknown[][];

    expect(articles[0]).toMatchObject({
      articleId: 'article-1',
      clusterStatus: 'clustered',
      clusterStatusLabel: '已聚类',
      fetchStatusLabel: '已抓取',
      aiStatusLabel: '已完成',
      publicStatusLabel: '已公开',
      eventStatusLabel: '有效',
      url: 'https://example.com/article?id=1',
    });
    expect(relations[0]).toMatchObject({ isRepresentative: true, representativeManual: true, eventStatusLabel: '有效' });
    expect(content).toHaveLength(3);
    expect(String(articles[0].summary)).toContain('LongTextChunks');
    expect(longText.filter((row) => row.sheetName === 'Articles' && row.field === 'summary')).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      url: 'https://example.com/feed',
      parserConfig: '{"headers":{"Authorization":"[REDACTED]"}}',
      statusLabel: '正常',
    });
    expect(meta.some((row) => row[0] === 'exportJobId' && row[1] === 'export-1')).toBe(true);
    expect(meta.some((row) => row[0] === 'errorCount' && row[1] === 0)).toBe(true);
  });
});
