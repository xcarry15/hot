import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { revealSensitiveSettings } from '@/lib/settings-service';

/**
 * POST /api/settings/reveal
 *
 * 受鉴权端点：复用 proxy.ts 的 Bearer token 校验，仅允许已登录用户读取
 * 敏感设置的明文值。GET /api/settings 始终脱敏；用户需要回显时由前端显式调用本端点。
 *
 * 单一数据源：由 settings-service 读取 settings-catalog 中的敏感字段白名单，
 * 禁止在路由内独立维护。
 *
 * 注：仅回显当前配置目录声明且由调用方请求的敏感字段，不兼容已移除的旧版全局 AI key。
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const requestedKeys = Array.isArray(body?.keys)
      ? body.keys.filter((key: unknown): key is string => typeof key === 'string')
      : undefined;
    return NextResponse.json(await revealSensitiveSettings(requestedKeys), {
      headers: { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' },
    });
  } catch (error: unknown) {
    return apiError(error, 'Failed to reveal settings');
  }
}
