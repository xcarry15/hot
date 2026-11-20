import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function protectedRequest(path: string, method = 'GET'): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method });
}

describe('P0-7 安全专项：受保护路由的路由层鉴权', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_TOKEN', 'route-auth-test-token');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ['articles 列表（敏感读）', '/api/articles', 'GET', () => import('@/app/api/articles/route').then((m) => m.GET)],
    ['settings 更新（敏感写）', '/api/settings', 'PUT', () => import('@/app/api/settings/route').then((m) => m.PUT)],
    ['backup 导出（敏感读）', '/api/backup', 'POST', () => import('@/app/api/backup/route').then((m) => m.POST)],
    ['crawl 触发（写）', '/api/crawl', 'POST', () => import('@/app/api/crawl/route').then((m) => m.POST)],
    ['tools 创建（写）', '/api/tools', 'POST', () => import('@/app/api/tools/route').then((m) => m.POST)],
    ['visit-analytics（敏感读）', '/api/visit-analytics', 'GET', () => import('@/app/api/visit-analytics/route').then((m) => m.GET)],
  ])('%s 未授权时返回 401', async (_label, path, method, load) => {
    const handler = await (load as () => Promise<(r: NextRequest) => Promise<Response>>)();
    const response = await handler(protectedRequest(path, method));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'Unauthorized' });
  });

  it('proxy.ts 公开白名单端点不被注入路由层鉴权', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const publicRoutes = [
      'admin-auth',
      'health',
      'public/share-poster',
      'public/visits',
      'public/articles',
      'public/articles/[id]',
      'public/articles/[id]/click',
      'public/articles/[id]/view',
    ];
    expect(publicRoutes).toHaveLength(8);
    for (const route of publicRoutes) {
      const source = readFileSync(join(process.cwd(), 'src/app/api', route, 'route.ts'), 'utf8');
      expect(source, `${route} 不应包含 requireAdminAuth`).not.toContain('requireAdminAuth');
    }
  });

  it('带合法 Bearer token 时路由层鉴权放行（不再返回 401）', async () => {
    const request = new NextRequest('http://localhost/api/articles', {
      method: 'GET',
      headers: { authorization: 'Bearer route-auth-test-token' },
    });
    const db = (await import('@/lib/db')).db;
    vi.mocked(db.$transaction).mockResolvedValue([[], 0] as never);
    const { GET } = await import('@/app/api/articles/route');
    const response = await GET(request);
    expect(response.status).not.toBe(401);
  });
});
