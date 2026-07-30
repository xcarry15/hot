import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  keywordFindMany: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    keyword: {
      findMany: mocks.keywordFindMany,
    },
    $queryRaw: mocks.queryRaw,
  },
}));

import { listKeywords } from '../src/lib/keyword-service';

describe('关键词命中统计', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.keywordFindMany.mockResolvedValue([
      { id: 'brand', category: '品牌', word: '奈雪' },
      { id: 'blacklist', category: '黑名单', word: '联商头条：' },
      { id: 'unused', category: '品牌', word: '未命中' },
    ]);
    mocks.queryRaw
      .mockResolvedValueOnce([{ id: 'brand', hitCount: 4n }])
      .mockResolvedValueOnce([{ id: 'blacklist', hitCount: 3n }]);
  });

  it('分别合并当前文章与黑名单拦截记录的命中数', async () => {
    await expect(listKeywords()).resolves.toEqual([
      { id: 'brand', category: '品牌', word: '奈雪', hitCount: 4 },
      { id: 'blacklist', category: '黑名单', word: '联商头条：', hitCount: 3 },
      { id: 'unused', category: '品牌', word: '未命中', hitCount: 0 },
    ]);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });
});
