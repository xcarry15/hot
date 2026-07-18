import { describe, expect, it } from 'vitest';
import {
  serializeArticleDetail,
  serializeArticleListItem,
  type ArticleDetailRecord,
} from '@/contracts/articles';

function articleRecord(): Omit<ArticleDetailRecord, 'source' | 'pushLogs'> {
  return {
    id: 'a1',
    eventId: 'e1',
    clusterStatus: 'clustered',
    clusteredAt: new Date('2026-07-09T02:00:00Z'),
    eventKey: '品牌|动作|事项',
    event: { id: 'e1', articleCount: 2, representativeArticleId: 'a1', pushedAt: new Date('2026-07-11T01:00:00Z') },
    sourceId: 's1',
    url: 'https://example.com/a1',
    title: '测试文章',
    originalSource: null,
    cleanContent: 'clean',
    relevance: 8,
    summary: 'summary',
    brand: '品牌',
    category: '品牌',
    tags: '[]',
    keyPoints: '[]',
    score: 80,
    eventScore: 85,
    contentScore: 75,
    rawScore: 80,
    adProbability: 10,
    aiConfidence: 90,
    aiStatus: 'done',
    fetchStatus: 'fetched',
    skipReason: null,
    isAd: false,
    reviewStatus: 'unreviewed',
    reviewReasonTags: '[]',
    reviewedAt: null,
    publicOverride: 'auto',
    publicStatus: 'published',
    pinUntil: null,
    aiSnapshot: '{}',
    manualOverrides: '[]',
    manualCorrectedAt: null,
    publicPublicationReason: 'eligible',
    viewCount: 0,
    originalClickCount: 0,
    publishedAt: new Date('2026-07-10T01:00:00Z'),
    createdAt: new Date('2026-07-09T01:00:00Z'),
    updatedAt: new Date('2026-07-11T01:00:00Z'),
  };
}

describe('Article API DTO', () => {
  it('保留列表与详情 source 的差异，并统一 Date 为 ISO 字符串', () => {
    const list = serializeArticleListItem({
      ...articleRecord(),
      source: { name: '示例源', type: 'rss' },
    });
    const detail = serializeArticleDetail({
      ...articleRecord(),
      source: { name: '示例源', type: 'rss', url: 'https://example.com/feed.xml' },
      pushLogs: [{
        id: 'p1',
        articleId: 'a1',
        status: 'success',
        errorMessage: '',
        retryCount: 0,
        webhookUrl: 'https://open.feishu.cn/hook/test',
        webhookRemark: '主群',
        createdAt: new Date('2026-07-11T02:00:00Z'),
      }],
    });

    expect(list.source).toEqual({ name: '示例源', type: 'rss' });
    expect(detail.source).toEqual({
      name: '示例源',
      type: 'rss',
      url: 'https://example.com/feed.xml',
    });
    expect(list.publishedAt).toBe('2026-07-10T01:00:00.000Z');
    expect(list.excerpt).toBe('summary');
    expect(list.aiConfidence).toBe(90);
    expect(list).not.toHaveProperty('cleanContent');
    expect(list).not.toHaveProperty('rawContent');
    expect(list).not.toHaveProperty('articleBody');
    expect(list).not.toHaveProperty('contentHash');
    expect(list).not.toHaveProperty('dedupDetail');
    expect(detail.pushLogs[0]?.createdAt).toBe('2026-07-11T02:00:00.000Z');
    expect(detail.pushLogs[0]?.webhookTarget).toBe('https://open.feishu.cn/…/***test');
    expect(detail.pushLogs[0]).not.toHaveProperty('webhookUrl');
  });
});
