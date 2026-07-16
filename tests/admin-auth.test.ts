import { describe, expect, it } from 'vitest';
import {
  createAdminSession,
  isValidAdminSession,
  isValidApiToken,
} from '@/lib/admin-auth';

describe('admin auth session', () => {
  it('会话值与 API_TOKEN 分离，且只能由同一 Token 验证', () => {
    const token = 'secret-token';
    const now = 1_750_000_000_000;
    const session = createAdminSession(token, now);

    expect(session).not.toBe(token);
    expect(isValidAdminSession(session, token, now)).toBe(true);
    expect(isValidAdminSession(session, 'another-token', now)).toBe(false);
    expect(isValidAdminSession(token, token, now)).toBe(false);
    expect(isValidApiToken(token, token)).toBe(true);
    expect(isValidApiToken('wrong', token)).toBe(false);
  });

  it('服务端拒绝过期会话，不依赖浏览器清理 Cookie', () => {
    const now = 1_750_000_000_000;
    const session = createAdminSession('secret-token', now);

    expect(isValidAdminSession(session, 'secret-token', now + 7 * 24 * 60 * 60 * 1000)).toBe(false);
  });
});
