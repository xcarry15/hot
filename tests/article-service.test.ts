import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  ArticleRevisionConflictError,
  buildArticleDeleteWhere,
  buildArticleListOrder,
  buildArticleListWhere,
  updateArticleEditorial,
} from '@/lib/article-service';

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

  it('低分析置信列表只返回 AI 已完成的文章', () => {
    expect(buildArticleListWhere({ maxConfidence: 70 })).toEqual({
      aiStatus: 'done',
      aiConfidence: { lt: 70 },
    });
  });

  it('搜索与异常条件同时生效', () => {
    const where = buildArticleListWhere({ anomaly: 'needs_attention', search: '咖啡' });
    expect(Array.isArray(where.AND)).toBe(true);
    expect(where.AND).toHaveLength(2);
  });

  it('全文搜索走派生搜索表，避免列表查询直接扫 Article 正文', () => {
    expect(buildArticleListWhere({ search: '肯德基' })).toEqual({
      AND: [{
        searchIndex: {
          is: {
            searchText: { contains: '肯德基' },
          },
        },
      }],
    });
  });

  it('删除筛选保持明确字段', () => {
    expect(buildArticleDeleteWhere({ aiStatus: 'failed', category: '餐饮', maxScore: 40 })).toEqual({
      aiStatus: 'failed',
      category: '餐饮',
      score: { lte: 40 },
    });
  });

  it('列表排序使用集中映射，并保留默认稳定排序', () => {
    expect(buildArticleListOrder('event_desc')).toEqual([
      { eventScore: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
    ]);
    expect(buildArticleListOrder()).toEqual([
      { publishedAt: 'desc' },
      { createdAt: 'desc' },
    ]);
  });
});

describe('article-service 编辑版本保护', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('打开详情后文章已被更新时拒绝覆盖旧版本', async () => {
    const currentUpdatedAt = new Date('2026-08-31T10:00:01.000Z');
    vi.mocked(db.article.findUnique).mockResolvedValue({ updatedAt: currentUpdatedAt } as never);

    await expect(updateArticleEditorial('article-1', {
      summary: '旧标签页的修改',
      expectedUpdatedAt: new Date('2026-08-31T10:00:00.000Z'),
    })).rejects.toBeInstanceOf(ArticleRevisionConflictError);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
