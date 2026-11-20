import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_SESSION_COOKIE, isValidAdminSession, isValidApiToken } from '@/lib/admin-auth';

/**
 * 路由层显式鉴权（纵深防御）。
 *
 * proxy.ts 已在边缘统一拦截受保护 API；本 helper 为敏感端点提供第二层校验，
 * 避免单点依赖 matcher。校验逻辑与 proxy 保持一致：
 * - Bearer API_TOKEN 有效 → 放行
 * - 会话 Cookie 有效 → 放行
 * - 生产环境未配置 API_TOKEN → 500（fail-closed，与 proxy 一致）
 * - 开发环境且未配置 token → 放行（保持本地 dev 可用）
 *
 * 返回 null 表示放行；否则返回应直接 reply 的 401/500 响应。
 */
export function requireAdminAuth(request: NextRequest): NextResponse | null {
  const expected = process.env.API_TOKEN;
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: 'API_TOKEN not configured on server' }, { status: 500 });
    }
    return null;
  }

  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token && isValidApiToken(token, expected)) return null;

  // 生产请求一律是 NextRequest（带 cookies）；裸 Request 仅出现在单元测试中。
  // 对没有 cookies 属性的裸 Request 做防御性处理，避免 request.cookies.get 抛 TypeError；
  // 非生产环境放行以保持业务单测可用（鉴权本身由 require-admin-auth / route-auth 专项覆盖），
  // 生产环境无有效凭证仍严格 fail-closed。
  const cookies = (request as { cookies?: { get(name: string): { value?: string } | undefined } }).cookies;
  const session = cookies?.get(ADMIN_SESSION_COOKIE)?.value;
  if (isValidAdminSession(session, expected)) return null;
  if (!cookies && process.env.NODE_ENV !== 'production') return null;

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
