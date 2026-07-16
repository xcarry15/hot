import { createFixedWindowRateLimiter } from '@/lib/fixed-window-rate-limit';

export const enforceAdminAuthRateLimit = createFixedWindowRateLimiter({
  windowMs: 10 * 60_000,
  maxRequests: 10,
  maxEntries: 5_000,
  errorMessage: '登录尝试过于频繁，请稍后再试',
});
