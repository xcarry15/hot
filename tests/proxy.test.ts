/**
 * API 鉴权代理测试（原 middleware，Next.js 16 重命名为 proxy）
 *
 * 验证：
 * - 生产环境所有 API（含 GET）缺 token 或错 token → 401
 * - 正确 Bearer → 放行
 * - 开发模式无 API_TOKEN → 放行
 * - 生产模式无 API_TOKEN → 500
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// 在 import proxy 之前设置环境变量
const originalEnv = { ...process.env };

describe('proxy auth', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function makeRequest(method: string, pathname: string, auth?: string) {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = auth;
    return new NextRequest(new URL(pathname, 'http://localhost:3011'), {
      method,
      headers,
    });
  }

  it('派生会话 Cookie 可访问后台，Cookie 值本身不是 API_TOKEN', async () => {
    process.env.API_TOKEN = 'secret123';
    (process.env as Record<string,string>).NODE_ENV = 'production';
    const [{ proxy }, { ADMIN_SESSION_COOKIE, createAdminSession }] = await Promise.all([
      import('@/proxy'),
      import('@/lib/admin-auth'),
    ]);
    const session = createAdminSession('secret123');
    const req = makeRequest('GET', '/admin');
    req.cookies.set(ADMIN_SESSION_COOKIE, session);
    const res = proxy(req);

    expect(session).not.toBe('secret123');
    expect(res.status).not.toBe(307);
  });

  it('旧版原始 API_TOKEN Cookie 不再被视为后台会话', async () => {
    process.env.API_TOKEN = 'secret123';
    (process.env as Record<string,string>).NODE_ENV = 'production';
    const [{ proxy }, { ADMIN_SESSION_COOKIE }] = await Promise.all([
      import('@/proxy'),
      import('@/lib/admin-auth'),
    ]);
    const req = makeRequest('GET', '/admin');
    req.cookies.set(ADMIN_SESSION_COOKIE, 'secret123');

    expect(proxy(req).status).toBe(307);
  });

  it('生产环境 GET /api/articles 无 token → 401', async () => {
    process.env.API_TOKEN = 'secret123';
    (process.env as Record<string,string>).NODE_ENV = 'production';
    const { proxy } = await import('@/proxy');
    const res = proxy(makeRequest('GET', '/api/articles'));
    expect(res.status).toBe(401);
  });

  it('生产环境健康检查无需 Token，但拒绝写请求', async () => {
    process.env.API_TOKEN = 'secret123';
    (process.env as Record<string,string>).NODE_ENV = 'production';
    const { proxy } = await import('@/proxy');
    expect(proxy(makeRequest('GET', '/api/health')).status).not.toBe(401);
    expect(proxy(makeRequest('HEAD', '/api/health')).status).not.toBe(401);
    expect(proxy(makeRequest('POST', '/api/health')).status).toBe(405);
  });

  it('POST /api/articles 无 token → 401', async () => {
    process.env.API_TOKEN = 'secret123';
    (process.env as Record<string,string>).NODE_ENV = 'production';
    const { proxy } = await import('@/proxy');
    const res = proxy(makeRequest('POST', '/api/articles'));
    expect(res.status).toBe(401);
  });

  it('POST /api/articles 错 token → 401', async () => {
    process.env.API_TOKEN = 'secret123';
    (process.env as Record<string,string>).NODE_ENV = 'production';
    const { proxy } = await import('@/proxy');
    const res = proxy(makeRequest('POST', '/api/articles', 'Bearer wrong'));
    expect(res.status).toBe(401);
  });

  it('POST /api/articles 正确 Bearer → 放行', async () => {
    process.env.API_TOKEN = 'secret123';
    (process.env as Record<string,string>).NODE_ENV = 'production';
    const { proxy } = await import('@/proxy');
    const res = proxy(makeRequest('POST', '/api/articles', 'Bearer secret123'));
    expect(res.status).not.toBe(401);
  });

  it('生产环境 GET /api/articles 正确 Bearer → 放行', async () => {
    process.env.API_TOKEN = 'secret123';
    (process.env as Record<string,string>).NODE_ENV = 'production';
    const { proxy } = await import('@/proxy');
    const res = proxy(makeRequest('GET', '/api/articles', 'Bearer secret123'));
    expect(res.status).not.toBe(401);
  });

  it('开发模式 + 无 API_TOKEN → POST 放行', async () => {
    delete process.env.API_TOKEN;
    (process.env as Record<string,string>).NODE_ENV = 'development';
    const { proxy } = await import('@/proxy');
    const res = proxy(makeRequest('POST', '/api/articles'));
    expect(res.status).not.toBe(401);
  });

  it('生产模式 + 无 API_TOKEN → POST 500', async () => {
    delete process.env.API_TOKEN;
    (process.env as Record<string,string>).NODE_ENV = 'production';
    const { proxy } = await import('@/proxy');
    const res = proxy(makeRequest('POST', '/api/articles'));
    expect(res.status).toBe(500);
  });

  it('Bearer 后空格 + 正确 token → 放行', async () => {
    process.env.API_TOKEN = 'mytoken';
    (process.env as Record<string,string>).NODE_ENV = 'production';
    const { proxy } = await import('@/proxy');
    const res = proxy(makeRequest('DELETE', '/api/articles/a1', 'Bearer mytoken'));
    expect(res.status).not.toBe(401);
  });

  it('无 Bearer 前缀 → 401', async () => {
    process.env.API_TOKEN = 'mytoken';
    (process.env as Record<string,string>).NODE_ENV = 'production';
    const { proxy } = await import('@/proxy');
    const res = proxy(makeRequest('POST', '/api/articles', 'mytoken'));
    expect(res.status).toBe(401);
  });
});
