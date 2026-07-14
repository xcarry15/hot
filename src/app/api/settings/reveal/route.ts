import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { revealSensitiveSettings } from '@/lib/settings-service';

/**
 * POST /api/settings/reveal
 *
 * 受鉴权端点：复用 proxy.ts 的 Bearer token 校验，仅允许已登录用户读取
 * 敏感设置的明文值。GET /api/settings 始终脱敏；用户需要回显时由前端显式调用本端点。
 *
 * 单一数据源：从 settings/route.ts 的 SENSITIVE_SETTING_KEYS 派生白名单，
 * 任何新敏感 key 只要加到那里就会自动参与 reveal，禁止在此处独立维护。
 *
 * 注：仅回显当前配置目录声明且由调用方请求的敏感字段，不兼容已移除的旧版全局 AI key。
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const requestedKeys = Array.isArray(body?.keys)
      ? body.keys.filter((key: unknown): key is string => typeof key === 'string')
      : undefined;
    return NextResponse.json(await revealSensitiveSettings(requestedKeys));
  } catch (error: unknown) {
    return apiError(error, 'Failed to reveal settings');
  }
}
