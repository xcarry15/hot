/**
 * Generic module-level cache with configurable TTL.
 * Used by filter.ts and ai.ts for brand/keyword caches.
 */

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

export function createCache<T>(ttlMs: number) {
  let entry: CacheEntry<T> | null = null;

  return {
    get(): T | null {
      if (entry && Date.now() < entry.expiry) return entry.data;
      return null;
    },
    set(data: T): void {
      entry = { data, expiry: Date.now() + ttlMs };
    },
    invalidate(): void {
      entry = null;
    },
  };
}
