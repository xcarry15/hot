/**
 * articles DELETE 路由 N+1 修复回归测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleFindMany: vi.fn(),
  articleDeleteMany: vi.fn(),
  articleUpdateMany: vi.fn(),
  articleUpdate: vi.fn(),
  pushLogDeleteMany: vi.fn(),
  transaction: vi.fn(),
}));

mocks.pushLogDeleteMany.mockImplementation((args) => ({ _op: 'pushLog.deleteMany', args }));
mocks.articleDeleteMany.mockImplementation((args) => ({ _op: 'article.deleteMany', args }));
mocks.articleUpdateMany.mockImplementation((args) => ({ _op: 'article.updateMany', args }));

vi.mock('@/lib/db', () => ({
  db: {
    article: {
      findMany: mocks.articleFindMany,
      deleteMany: mocks.articleDeleteMany,
      updateMany: mocks.articleUpdateMany,
      update: mocks.articleUpdate,
    },
    pushLog: {
      deleteMany: mocks.pushLogDeleteMany,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('@/lib/ai', () => ({
  processWithAI: vi.fn(),
}));

import { DELETE as articlesDELETE } from '@/app/api/articles/route';

describe('articles DELETE 修复', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pushLogDeleteMany.mockImplementation((args) => ({ _op: 'pushLog.deleteMany', args }));
    mocks.articleDeleteMany.mockImplementation((args) => ({ _op: 'article.deleteMany', args }));
    mocks.articleUpdateMany.mockImplementation((args) => ({ _op: 'article.updateMany', args }));
    mocks.articleFindMany.mockResolvedValue([]);
    mocks.articleUpdate.mockResolvedValue({});
  });

  it('按 ids 删除：单次 $transaction 包含 pushLog + article', async () => {
    const ids = ['a1', 'a2', 'a3'];
    mocks.pushLogDeleteMany.mockResolvedValue({ count: 3 });
    mocks.articleUpdateMany.mockResolvedValue({ count: 0 });
    mocks.articleDeleteMany.mockResolvedValue({ count: 3 });
    mocks.transaction.mockImplementation((operation) => operation({
      pushLog: { deleteMany: mocks.pushLogDeleteMany },
      article: { findMany: mocks.articleFindMany, update: mocks.articleUpdate, updateMany: mocks.articleUpdateMany, deleteMany: mocks.articleDeleteMany },
    }));

    const req = new Request(`http://localhost/api/articles?ids=${ids.join(',')}`, {
      method: 'DELETE',
    });

    const res = await articlesDELETE(req);
    const body = await res.json();

    expect(body.deleted).toBe(3);
    expect(body.pushLogsDeleted).toBe(3);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.pushLogDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.articleDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.articleFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.pushLogDeleteMany.mock.calls[0][0].where.articleId).toEqual({ in: ids });
    expect(mocks.articleDeleteMany.mock.calls[0][0].where.id).toEqual({ in: ids });
  });

  it('空 ids 直接返回 0', async () => {
    // 用一个会导致 idList 过滤后为空的输入
    const req = new Request('http://localhost/api/articles?ids=,,,', {
      method: 'DELETE',
    });

    const res = await articlesDELETE(req);
    const body = await res.json();

    expect(body.deleted).toBe(0);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('按过滤条件删除：findMany + $transaction', async () => {
    const ids = ['f1', 'f2', 'f3', 'f4'];
    mocks.articleFindMany
      .mockResolvedValueOnce(ids.map(id => ({ id })))
      .mockResolvedValueOnce([]);
    mocks.pushLogDeleteMany.mockResolvedValue({ count: 4 });
    mocks.articleUpdateMany.mockResolvedValue({ count: 0 });
    mocks.articleDeleteMany.mockResolvedValue({ count: 4 });
    mocks.transaction.mockImplementation((operation) => operation({
      pushLog: { deleteMany: mocks.pushLogDeleteMany },
      article: { findMany: mocks.articleFindMany, update: mocks.articleUpdate, updateMany: mocks.articleUpdateMany, deleteMany: mocks.articleDeleteMany },
    }));

    const req = new Request('http://localhost/api/articles?status=skipped', {
      method: 'DELETE',
    });

    const res = await articlesDELETE(req);
    const body = await res.json();

    expect(body.deleted).toBe(4);
    expect(mocks.articleFindMany).toHaveBeenCalledTimes(2);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
});
