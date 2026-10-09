import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(async () => {
  (await import('@/lib/public-article-cache')).invalidatePublicArticleCache();
});

describe('公开缓存的跨模块实例失效', () => {
  it('不同模块实例共用详情、列表与修订缓存，任一实例均可失效全部条目', async () => {
    const first = await import('@/lib/public-article-cache');
    first.publicArticleDetailCache.set('e1', { value: Promise.resolve(null), expiresAt: Date.now() + 30_000 });
    first.publicArticleListCache.set('list', {
      value: Promise.resolve({ total: 0, groups: [], displayedArticleCount: 0, displayedDateCount: 0, nextCursor: null, hasMore: false }),
      expiresAt: Date.now() + 30_000,
    });
    first.publicArticleRevisionCache.set('revision', { value: Promise.resolve({ total: 0, revision: 'test' }), expiresAt: Date.now() + 30_000 });

    vi.resetModules();
    const second = await import('@/lib/public-article-cache');
    expect(second.publicArticleDetailCache).toBe(first.publicArticleDetailCache);
    expect(second.publicArticleListCache).toBe(first.publicArticleListCache);
    expect(second.publicArticleRevisionCache).toBe(first.publicArticleRevisionCache);
    second.invalidatePublicArticleCache();

    expect(first.publicArticleDetailCache.size).toBe(0);
    expect(first.publicArticleListCache.size).toBe(0);
    expect(first.publicArticleRevisionCache.size).toBe(0);
  });
});
