import type { PublicArticleListResponseDto } from '@/contracts/public-articles';

export type PublicArticleCacheEntry = {
  expiresAt: number;
  value: Promise<PublicArticleListResponseDto>;
};

const MAX_PUBLIC_ARTICLE_CACHE_ENTRIES = 50;

class BoundedPublicArticleCache extends Map<string, PublicArticleCacheEntry> {
  override get(key: string): PublicArticleCacheEntry | undefined {
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

  override set(key: string, value: PublicArticleCacheEntry): this {
    super.delete(key);
    super.set(key, value);
    while (this.size > MAX_PUBLIC_ARTICLE_CACHE_ENTRIES) {
      const oldestKey = this.keys().next().value as string | undefined;
      if (!oldestKey) break;
      super.delete(oldestKey);
    }
    return this;
  }
}

export const publicArticleListCache = new BoundedPublicArticleCache();

export function invalidatePublicArticleCache(): void {
  publicArticleListCache.clear();
}
