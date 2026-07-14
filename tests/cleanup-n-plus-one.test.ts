/**
 * cleanup/articles 路由 N+1 修复回归测试
 *
 * 验证修复后：N+1 次 deleteMany 循环 → 单次 $transaction([...])
 *
 * 关键断言：mock.pushLogDeleteMany 只在 $transaction 内部被调用 1 次（不是 N 次循环）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleFindMany: vi.fn(),
  articleDeleteMany: vi.fn(),
  pushLogDeleteMany: vi.fn(),
  discardedDeleteMany: vi.fn(),
  discardedRetryAuditDeleteMany: vi.fn(),
  fetchLogDeleteMany: vi.fn(),
  jobDeleteMany: vi.fn(),
  sourceUpdateMany: vi.fn(),
  settingFindMany: vi.fn(),
  settingFindUnique: vi.fn(),
  settingUpsert: vi.fn(),
  transaction: vi.fn(),
}));

// 让 prisma 操作 mock 把"where 参数"也作为返回值的标记字段，
// 方便测试断言实际传入的 where 条件
mocks.pushLogDeleteMany.mockImplementation((args) => ({ _op: 'pushLog.deleteMany', args }));
mocks.articleDeleteMany.mockImplementation((args) => ({ _op: 'article.deleteMany', args }));
mocks.discardedDeleteMany.mockImplementation(() => ({ _op: 'discardedItem.deleteMany', count: 0 }));
mocks.fetchLogDeleteMany.mockImplementation(() => ({ _op: 'fetchLog.deleteMany', count: 0 }));
mocks.jobDeleteMany.mockImplementation(() => ({ _op: 'job.deleteMany', count: 0 }));
mocks.sourceUpdateMany.mockImplementation(() => ({ _op: 'source.updateMany', count: 0 }));
mocks.settingUpsert.mockImplementation((args) => ({ _op: 'setting.upsert', args }));

vi.mock('@/lib/db', () => ({
  db: {
    article: {
      findMany: mocks.articleFindMany,
      deleteMany: mocks.articleDeleteMany,
    },
    pushLog: {
      deleteMany: mocks.pushLogDeleteMany,
    },
    discardedItem: {
      deleteMany: mocks.discardedDeleteMany,
    },
    discardedRetryAudit: {
      deleteMany: mocks.discardedRetryAuditDeleteMany,
    },
    fetchLog: {
      deleteMany: mocks.fetchLogDeleteMany,
    },
    job: {
      deleteMany: mocks.jobDeleteMany,
    },
    source: {
      updateMany: mocks.sourceUpdateMany,
    },
    setting: {
      findMany: mocks.settingFindMany,
      findUnique: mocks.settingFindUnique,
      upsert: mocks.settingUpsert,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('@/lib/worker-stop', () => ({
  abortCurrentJob: vi.fn(),
}));

import { POST as cleanupPOST } from '@/app/api/cleanup/route';

describe('cleanup N+1 修复', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 恢复 mockImplementation（clearAllMocks 会清除实现）
    mocks.pushLogDeleteMany.mockImplementation((args) => ({ _op: 'pushLog.deleteMany', args }));
    mocks.articleDeleteMany.mockImplementation((args) => ({ _op: 'article.deleteMany', args }));
    mocks.discardedDeleteMany.mockImplementation(() => ({ _op: 'discardedItem.deleteMany', count: 0 }));
    mocks.discardedRetryAuditDeleteMany.mockImplementation(() => ({ _op: 'discardedRetryAudit.deleteMany', count: 0 }));
    mocks.fetchLogDeleteMany.mockImplementation(() => ({ _op: 'fetchLog.deleteMany', count: 0 }));
    mocks.jobDeleteMany.mockImplementation(() => ({ _op: 'job.deleteMany', count: 0 }));
    mocks.settingUpsert.mockImplementation((args) => ({ _op: 'setting.upsert', args }));
    mocks.settingFindUnique.mockResolvedValue(null);
  });

  it('low-quality 清理：findMany 1 次 + $transaction 1 次（不再循环 deleteMany）', async () => {
    const mockIds = ['a1', 'a2', 'a3', 'a4', 'a5'];
    mocks.articleFindMany.mockResolvedValue(mockIds.map(id => ({ id })));
    // transaction 接收 ops 数组，对每个执行（这里简化：返回数组）
    mocks.transaction.mockImplementation((ops) => {
      return Promise.all(ops.map((op: { _op: string }) =>
        op._op === 'pushLog.deleteMany' ? { count: 5 } : { count: 5 }
      ));
    });

    const req = new Request('http://localhost/api/cleanup', {
      method: 'POST',
      body: JSON.stringify({ action: 'low-quality' }),
    });

    const res = await cleanupPOST(req);
    const body = await res.json();

    expect(body.deleted).toBe(5);
    expect(body.pushLogsDeleted).toBe(5);
    expect(mocks.articleFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);

    // 关键：pushLogDeleteMany 只被调 1 次（不是 5 次）
    expect(mocks.pushLogDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.articleDeleteMany).toHaveBeenCalledTimes(1);

    // where 用 in 语法，包含全部 ids
    expect(mocks.pushLogDeleteMany.mock.calls[0][0].where.articleId).toEqual({ in: mockIds });
    expect(mocks.articleDeleteMany.mock.calls[0][0].where.id).toEqual({ in: mockIds });
  });

  it('pushed-articles 清理：同样走 $transaction 模式', async () => {
    const mockIds = ['x1', 'x2', 'x3'];
    mocks.articleFindMany.mockResolvedValue(mockIds.map(id => ({ id })));
    mocks.transaction.mockImplementation((ops) => {
      return Promise.all(ops.map((op: { _op: string }) =>
        op._op === 'pushLog.deleteMany' ? { count: 2 } : { count: 3 }
      ));
    });

    const req = new Request('http://localhost/api/cleanup', {
      method: 'POST',
      body: JSON.stringify({ action: 'pushed-articles' }),
    });

    const res = await cleanupPOST(req);
    const body = await res.json();

    expect(body.deleted).toBe(3);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.pushLogDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.articleDeleteMany).toHaveBeenCalledTimes(1);
  });

  it('空结果集：不调用 $transaction', async () => {
    mocks.articleFindMany.mockResolvedValue([]);

    const req = new Request('http://localhost/api/cleanup', {
      method: 'POST',
      body: JSON.stringify({ action: 'low-quality' }),
    });

    const res = await cleanupPOST(req);
    const body = await res.json();

    expect(body.deleted).toBe(0);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('purge-all 清空后阻止 scheduler 重新采集', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pushLogDeleteMany.mockImplementation((args) => ({ _op: 'pushLog.deleteMany', args, count: 0 }));
    mocks.articleDeleteMany.mockImplementation((args) => ({ _op: 'article.deleteMany', args, count: 0 }));
    mocks.discardedDeleteMany.mockImplementation(() => ({ _op: 'discardedItem.deleteMany', count: 0 }));
    mocks.discardedRetryAuditDeleteMany.mockImplementation(() => ({ _op: 'discardedRetryAudit.deleteMany', count: 0 }));
    mocks.fetchLogDeleteMany.mockImplementation(() => ({ _op: 'fetchLog.deleteMany', count: 0 }));
    mocks.jobDeleteMany.mockImplementation(() => ({ _op: 'job.deleteMany', count: 0 }));
    mocks.sourceUpdateMany.mockImplementation(() => ({ _op: 'source.updateMany', count: 0 }));
    mocks.settingUpsert.mockImplementation((args) => ({ _op: 'setting.upsert', args }));
    mocks.settingFindUnique.mockResolvedValue(null);
    // $transaction 接收 ops 数组；purge-all 顺序：
    // pushLog/article/discardedItem/fetchLog/job/setting(auto_crawl)/setting(last_crawl)
    mocks.transaction.mockImplementation(async (ops) =>
      ops.map((op: { _op: string }) => op._op?.endsWith('.deleteMany') ? { count: 0 } : { count: 0 })
    );
  });

  it('purge-all 在 transaction 内重置采集计时并把自动采集临时设为 false，事务后恢复原值', async () => {
    const before = Date.now();
    const req = new Request('http://localhost/api/cleanup', {
      method: 'POST',
      body: JSON.stringify({ action: 'purge-all' }),
    });

    const res = await cleanupPOST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.deleted).toBeDefined();
    expect(mocks.transaction).toHaveBeenCalledTimes(1);

    // transaction 内的 upsert 操作：auto_crawl_enabled=false + last_crawl_at=now
    const ops = mocks.transaction.mock.calls[0][0] as Array<{ _op: string; args: { where: { key: string }; update: { value: string }; create: { value: string } } }>;
    const upsertOps = ops.filter(op => op._op === 'setting.upsert');
    const autoCrawlOp = upsertOps.find(op => op.args.where.key === 'auto_crawl_enabled');
    const lastCrawlOp = upsertOps.find(op => op.args.where.key === 'scheduler_last_crawl_at');
    expect(autoCrawlOp?.args.update.value).toBe('false');
    expect(lastCrawlOp).toBeDefined();
    const stamped = Number(lastCrawlOp!.args.update.value);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());

    // 事务后恢复：setting.upsert 总调用 = 2(事务内) + 1(恢复) = 3
    expect(mocks.settingUpsert).toHaveBeenCalledTimes(3);
    // 恢复调用：原本无设置按默认关闭 → 恢复为 'false'
    const restoreCall = mocks.settingUpsert.mock.calls[2][0];
    expect(restoreCall.where.key).toBe('auto_crawl_enabled');
    expect(restoreCall.update.value).toBe('false');
  });

  it('原自动采集为关闭时，恢复后仍为 false', async () => {
    mocks.settingFindUnique.mockResolvedValue({ value: 'false' });

    const req = new Request('http://localhost/api/cleanup', {
      method: 'POST',
      body: JSON.stringify({ action: 'purge-all' }),
    });

    await cleanupPOST(req);

    const restoreCall = mocks.settingUpsert.mock.calls[2][0];
    expect(restoreCall.update.value).toBe('false');
  });
});
