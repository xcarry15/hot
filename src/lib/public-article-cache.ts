import type { PublicArticleListResponseDto } from '@/contracts/public-articles';

export type PublicArticleCacheEntry = {
  expiresAt: number;
  value: Promise<PublicArticleListResponseDto>;
};

export const publicArticleListCache = new Map<string, PublicArticleCacheEntry>();

export function invalidatePublicArticleCache(): void {
  publicArticleListCache.clear();
}
