import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArticleDetailDto } from '@/contracts/articles';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/request-json.client', () => ({ requestJson: mocks.request }));

import { fetchArticleDetail, invalidateArticleDetailCache, primeArticleDetailCache } from '@/features/articles-api.client';

describe('文章详情缓存的迟到失败', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    invalidateArticleDetailCache();
  });

  it.each(['prime', 'reload'])('旧请求失败不能删除 %s 创建的新缓存', async (replacement) => {
    let rejectOld!: (error: Error) => void;
    mocks.request.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectOld = reject; }));
    const pending = fetchArticleDetail('a1');
    const rejected = expect(pending).rejects.toThrow('late failure');
    const fresh = { id: 'a1', title: '新标题' } as ArticleDetailDto;

    if (replacement === 'prime') {
      primeArticleDetailCache(fresh);
    } else {
      invalidateArticleDetailCache('a1');
      mocks.request.mockResolvedValueOnce(fresh);
      await fetchArticleDetail('a1');
    }
    rejectOld(new Error('late failure'));
    await rejected;

    await expect(fetchArticleDetail('a1')).resolves.toBe(fresh);
    expect(mocks.request).toHaveBeenCalledTimes(replacement === 'prime' ? 1 : 2);
  });

  it('当前请求失败后允许重新获取', async () => {
    mocks.request.mockRejectedValueOnce(new Error('failed'));
    await expect(fetchArticleDetail('a1')).rejects.toThrow('failed');
    const fresh = { id: 'a1' } as ArticleDetailDto;
    mocks.request.mockResolvedValueOnce(fresh);

    await expect(fetchArticleDetail('a1')).resolves.toBe(fresh);
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
});
