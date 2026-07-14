import { NextResponse, type NextRequest } from 'next/server';

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
  const expected = process.env.API_TOKEN;

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
  if (!token || token !== expected) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
