import type { PublicArticleDetailDto, PublicArticleFeedRevisionDto, PublicArticleListResponseDto } from '@/contracts/public-articles';

export type PublicArticleCacheEntry<T> = {
  expiresAt: number;
  value: Promise<T>;
};

const MAX_PUBLIC_ARTICLE_CACHE_ENTRIES = 50;
const MAX_PUBLIC_ARTICLE_DETAIL_CACHE_ENTRIES = 100;

class BoundedPublicArticleCache<T> extends Map<string, PublicArticleCacheEntry<T>> {
  constructor(private readonly maxEntries: number) {
    super();
  }

  override get(key: string): PublicArticleCacheEntry<T> | undefined {
    const entry = super.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      super.delete(key);
      return undefined;
    }
    // Map 的插入顺序同时作为近似 LRU 顺序。
    super.delete(key);
    super.set(key, entry);
    return entry;
  }

  override set(key: string, value: PublicArticleCacheEntry<T>): this {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.maxEntries) {
      const oldestKey = this.keys().next().value as string | undefined;
      if (!oldestKey) break;
      super.delete(oldestKey);
    }
    return this;
  }
}

type PublicArticleCaches = {
  revision: BoundedPublicArticleCache<PublicArticleFeedRevisionDto>;
  list: BoundedPublicArticleCache<PublicArticleListResponseDto>;
  detail: BoundedPublicArticleCache<PublicArticleDetailDto | null>;
};

// Next 的页面、Route Handler 和调度器可能加载独立的模块实例。
// 单进程部署共用一份缓存，确保后台写入能失效公开页面持有的条目。
const cacheGlobal = globalThis as typeof globalThis & { hotPublicArticleCaches?: PublicArticleCaches };
const caches = cacheGlobal.hotPublicArticleCaches ??= {
  revision: new BoundedPublicArticleCache<PublicArticleFeedRevisionDto>(20),
  list: new BoundedPublicArticleCache<PublicArticleListResponseDto>(MAX_PUBLIC_ARTICLE_CACHE_ENTRIES),
  detail: new BoundedPublicArticleCache<PublicArticleDetailDto | null>(MAX_PUBLIC_ARTICLE_DETAIL_CACHE_ENTRIES),
};

export const publicArticleRevisionCache = caches.revision;
export const publicArticleListCache = caches.list;
export const publicArticleDetailCache = caches.detail;

export function invalidatePublicArticleCache(): void {
  publicArticleRevisionCache.clear();
  publicArticleListCache.clear();
  publicArticleDetailCache.clear();
}
