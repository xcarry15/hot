import { describe, expect, it } from 'vitest';
import {
  createFixedWindowRateLimiter,
  getTrustedClientKey,
} from '@/lib/fixed-window-rate-limit';

describe('fixed window rate limit', () => {
  it('优先使用 Nginx 覆盖的 X-Real-IP，回退取 X-Forwarded-For 最右侧', () => {
    const withRealIp = new Request('http://localhost', {
      headers: {
        'x-real-ip': '10.0.0.8',
        'x-forwarded-for': 'spoofed, 10.0.0.8',
      },
    });
    const forwardedOnly = new Request('http://localhost', {
      headers: { 'x-forwarded-for': 'spoofed, 10.0.0.9' },
    });

    expect(getTrustedClientKey(withRealIp)).toBe('10.0.0.8');
    expect(getTrustedClientKey(forwardedOnly)).toBe('10.0.0.9');
  });

  it('达到容量上限后拒绝新 key，避免攻击者用伪造 IP 撑爆 Map', () => {
    const limiter = createFixedWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      maxEntries: 1,
      errorMessage: 'limited',
    });

    expect(limiter(new Request('http://localhost', { headers: { 'x-real-ip': '1.1.1.1' } }))).toBeNull();
    const blocked = limiter(new Request('http://localhost', { headers: { 'x-real-ip': '2.2.2.2' } }));
    expect(blocked?.status).toBe(429);
  });
});
