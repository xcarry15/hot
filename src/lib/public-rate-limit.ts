import { createFixedWindowRateLimiter } from '@/lib/fixed-window-rate-limit';

export const enforcePublicRateLimit = createFixedWindowRateLimiter({
  windowMs: 60_000,
  maxRequests: 120,
  maxEntries: 5_000,
  errorMessage: 'Too many requests',
});
