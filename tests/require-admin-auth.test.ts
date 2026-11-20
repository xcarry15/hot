import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { requireAdminAuth } from '@/lib/require-admin-auth';
import { ADMIN_SESSION_COOKIE, createAdminSession } from '@/lib/admin-auth';

describe('route-level admin auth (defense in depth)', () => {
  const prevToken = process.env.API_TOKEN;
  const prevSecret = process.env.SESSION_SECRET;
  const env = process.env as Record<string, string | undefined>;
  const prevNode = env.NODE_ENV;
  afterEach(() => {
    if (prevToken === undefined) delete process.env.API_TOKEN; else process.env.API_TOKEN = prevToken;
    if (prevSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prevSecret;
    if (prevNode === undefined) delete env.NODE_ENV; else env.NODE_ENV = prevNode;
  });

  function req(headers: Record<string,string> = {}, cookies: Record<string,string> = {}) {
    const r = new NextRequest('http://localhost/api/settings/reveal', { method: 'POST', headers });
    for (const [k,v] of Object.entries(cookies)) r.cookies.set(k,v);
    return r;
  }

  it('生产环境无 API_TOKEN 时 fail-closed 返回 500', () => {
    delete process.env.API_TOKEN;
    env.NODE_ENV = 'production';
    const res = requireAdminAuth(req());
    expect(res?.status).toBe(500);
  });

  it('开发环境无 token 时放行（保持本地 dev 可用）', () => {
    delete process.env.API_TOKEN;
    env.NODE_ENV = 'development';
    expect(requireAdminAuth(req())).toBeNull();
  });

  it('有效 Bearer token 放行，无效返回 401', () => {
    process.env.API_TOKEN = 'the-token';
    env.NODE_ENV = 'production';
    expect(requireAdminAuth(req({ authorization: 'Bearer the-token' }))).toBeNull();
    expect(requireAdminAuth(req({ authorization: 'Bearer wrong' }))?.status).toBe(401);
    expect(requireAdminAuth(req())?.status).toBe(401);
  });

  it('有效会话 Cookie 放行；API_TOKEN 伪造的会话被拒（SESSION_SECRET 已配置）', () => {
    process.env.API_TOKEN = 'the-token';
    process.env.SESSION_SECRET = 'independent-secret';
    env.NODE_ENV = 'production';
    const good = createAdminSession('the-token');
    expect(requireAdminAuth(req({}, { [ADMIN_SESSION_COOKIE]: good }))).toBeNull();
    delete process.env.SESSION_SECRET;
    const forgedByToken = createAdminSession('the-token');
    process.env.SESSION_SECRET = 'independent-secret';
    expect(requireAdminAuth(req({}, { [ADMIN_SESSION_COOKIE]: forgedByToken }))?.status).toBe(401);
  });
});
