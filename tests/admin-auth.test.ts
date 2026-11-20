import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
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

describe('admin auth session secret isolation', () => {
  const original = process.env.SESSION_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = original;
  });

  it('配置独立 SESSION_SECRET 后会话与 API_TOKEN 解耦', () => {
    process.env.SESSION_SECRET = 'independent-session-secret';
    const now = 1_750_000_000_000;
    const session = createAdminSession('token-A', now);
    // 同一 session secret、不同 API_TOKEN 仍可验签（签名不再依赖 API_TOKEN）
    expect(isValidAdminSession(session, 'token-B', now)).toBe(true);
    // 所持 API_TOKEN 不能据此伪造会话（用 API_TOKEN 签名会被拒）
    const forged = `${now + 1000}.${createHmac('sha256', 'token-A').update(`hot2-admin-session-v1:${now + 1000}`).digest('base64url')}`;
    expect(isValidAdminSession(forged, 'token-A', now)).toBe(false);
  });

  it('未配置 SESSION_SECRET 时保持 API_TOKEN 签名的向后兼容', () => {
    delete process.env.SESSION_SECRET;
    const now = 1_750_000_000_000;
    const legacy = createAdminSession('legacy-token', now);
    expect(isValidAdminSession(legacy, 'legacy-token', now)).toBe(true);
    expect(isValidAdminSession(legacy, 'other-token', now)).toBe(false);
  });

  it('升级到 SESSION_SECRET 后旧 API_TOKEN 签名会话失效（须重新登录）', () => {
    delete process.env.SESSION_SECRET;
    const now = 1_750_000_000_000;
    const legacy = createAdminSession('legacy-token', now);
    expect(isValidAdminSession(legacy, 'legacy-token', now)).toBe(true);

    process.env.SESSION_SECRET = 'new-independent-secret';
    // 配置独立密钥后，用 API_TOKEN 签名的旧会话被拒，杜绝 Token 伪造会话
    expect(isValidAdminSession(legacy, 'legacy-token', now)).toBe(false);
    const fresh = createAdminSession('rotated-token', now);
    expect(isValidAdminSession(fresh, 'rotated-token', now)).toBe(true);
  });
});
