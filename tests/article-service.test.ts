import { describe, expect, it } from 'vitest';
import { buildArticleDeleteWhere, buildArticleListWhere } from '@/lib/article-service';

describe('article-service filters', () => {
  it('全量列表缺省不加待处理条件', () => {
    expect(buildArticleListWhere({})).toEqual({});
  });

  it('需要关注只包含聚类复核与低分析置信，不混入默认未审核或技术异常', () => {
    expect(buildArticleListWhere({ anomaly: 'needs_attention' })).toEqual({
      AND: [{ OR: [
        { clusterStatus: 'needs_review' },
        { aiStatus: 'done', aiConfidence: { lt: 70 } },
      ] }],
    });
  });

  it('搜索与异常条件同时生效', () => {
    const where = buildArticleListWhere({ anomaly: 'needs_attention', search: '咖啡' });
    expect(Array.isArray(where.AND)).toBe(true);
    expect(where.AND).toHaveLength(2);
  });

  it('删除筛选保持明确字段', () => {
    expect(buildArticleDeleteWhere({ aiStatus: 'failed', category: '餐饮', maxScore: 40 })).toEqual({
      aiStatus: 'failed',
      category: '餐饮',
      score: { lte: 40 },
    });
  });
});
