import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { processAllPending } from '@/lib/pipeline/process';
import { buildClusterPendingWhere } from '@/lib/pipeline/cluster';

describe('自动流水线来源资格', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.article.count).mockResolvedValue(0);
    vi.mocked(db.article.findMany).mockResolvedValue([]);
    vi.mocked(db.article.updateMany).mockResolvedValue({ count: 0 });
  });

  it('正文重置、恢复、计数、取批次和日期修复均排除删除来源', async () => {
    await processAllPending();
    for (const mock of [db.article.updateMany, db.article.count, db.article.findMany]) {
      expect(mock).toHaveBeenCalled();
      for (const [query] of vi.mocked(mock).mock.calls) {
        expect(query?.where?.source).toEqual({ is: { deletedAt: null } });
      }
    }
  });

  it('聚类包括强制重试仍排除删除来源，禁用策略保持不变', () => {
    for (const forceRetry of [false, true]) {
      expect(buildClusterPendingWhere(new Date(), forceRetry).source).toEqual({ is: { deletedAt: null } });
    }
  });
});
