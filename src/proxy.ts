import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_SESSION_COOKIE } from '@/lib/admin-auth';

/**
 * API 鉴权代理（原 middleware，Next.js 16 重命名为 proxy）
 *
 * 策略：
 * - 生产环境所有 API（含 GET）均要求 `Authorization: Bearer <API_TOKEN>`；
 *   业务数据、Webhook 投递历史与 AI 产出不应默认公开。
 * - 开发环境保持无 token 可用；设置 API_TOKEN 后同样统一鉴权。
 * - 开发模式（无 API_TOKEN + NODE_ENV !== 'production'）放行
 * - 生产模式无 API_TOKEN → 拒绝所有受保护操作（fail-closed，避免默认放行）
 *
 * 部署：生产环境在 .env 设置 `API_TOKEN=<random-string>`；未配置即拒绝 API 请求。
 * 客户端：请求 helper 从 localStorage 读 token（key=api_token）并显式加 header。
 */

export function proxy(request: NextRequest) {
  // Public endpoints are deliberately allow-listed and read-only. Never make
  // the existing admin article/settings APIs anonymous by broadening this rule.
  const pathname = request.nextUrl.pathname;
  const isAdminAuthApi = pathname === '/api/admin-auth';
  if (isAdminAuthApi) {
    if (!['POST', 'DELETE'].includes(request.method)) {
      return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
    }
    return NextResponse.next();
  }

  const isPublicArticleClickApi = /^\/api\/public\/articles\/[^/]+\/click$/.test(pathname);
  if (isPublicArticleClickApi) {
    if (request.method !== 'POST') {
      return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
    }
    return NextResponse.next();
  }

  const isPublicArticleApi = pathname === '/api/public/articles'
    || pathname.startsWith('/api/public/articles/');
  if (isPublicArticleApi) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
    }
    return NextResponse.next();
  }

  const expected = process.env.API_TOKEN;

  const isAdminPage = pathname === '/admin' || pathname.startsWith('/admin/');
  const isAdminLoginPage = pathname === '/admin/login';
  const session = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (isAdminPage && !isAdminLoginPage) {
    if (!expected && process.env.NODE_ENV !== 'production') return NextResponse.next();
    if (!expected) {
      return NextResponse.redirect(new URL('/admin/login?error=config', request.url));
    }
    if (session !== expected) {
      const next = `${pathname}${request.nextUrl.search}`;
      return NextResponse.redirect(new URL(`/admin/login?next=${encodeURIComponent(next)}`, request.url));
    }
    return NextResponse.next();
  }

  if (isAdminLoginPage && expected && session === expected) {
    return NextResponse.redirect(new URL('/admin', request.url));
  }
  if (isAdminLoginPage && !expected && process.env.NODE_ENV !== 'production') {
    return NextResponse.redirect(new URL('/admin', request.url));
  }
  if (isAdminLoginPage) return NextResponse.next();

  // 开发模式 + 未设置 token：放行（避免破坏本地 dev）。生产环境 fail-closed。
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'API_TOKEN not configured on server' },
        { status: 500 }
      );
    }
    return NextResponse.next();
  }

  // 校验 Bearer token
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (expected && session === expected) {
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${expected}`);
    return NextResponse.next({ request: { headers } });
  }
  if (!token || token !== expected) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*', '/admin', '/admin/:path*'],
};
