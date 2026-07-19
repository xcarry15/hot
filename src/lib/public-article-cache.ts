import type { PublicArticleDetailDto, PublicArticleListResponseDto } from '@/contracts/public-articles';

export type PublicArticleCacheEntry<T> = {
  expiresAt: number;
  value: Promise<T>;
};

const MAX_PUBLIC_ARTICLE_CACHE_ENTRIES = 50;
const MAX_PUBLIC_ARTICLE_DETAIL_CACHE_ENTRIES = 100;
const MAX_PUBLIC_ARTICLE_COUNT_CACHE_ENTRIES = 20;

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

export const publicArticleListCache = new BoundedPublicArticleCache<PublicArticleListResponseDto>(MAX_PUBLIC_ARTICLE_CACHE_ENTRIES);
export const publicArticleDetailCache = new BoundedPublicArticleCache<PublicArticleDetailDto | null>(MAX_PUBLIC_ARTICLE_DETAIL_CACHE_ENTRIES);
export const publicArticleCountCache = new BoundedPublicArticleCache<number>(MAX_PUBLIC_ARTICLE_COUNT_CACHE_ENTRIES);

export function invalidatePublicArticleCache(): void {
  publicArticleListCache.clear();
  publicArticleDetailCache.clear();
  publicArticleCountCache.clear();
}
