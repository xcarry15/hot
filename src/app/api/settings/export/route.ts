import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { exportSettings } from '@/lib/settings-service';

/**
 * POST /api/settings/export
 *
 * 受鉴权端点。导出 EXPORTABLE_SETTING_KEYS
 * 的真实(未脱敏)值,含明文密钥,用于整机备份/迁移。
 *
 * 使用 POST 表达“导出明文备份”这个高风险动作；所有 API 请求均由 proxy 鉴权。
 */
export async function POST() {
  try {
    return NextResponse.json(await exportSettings());
  } catch (error: unknown) {
    return apiError(error, 'Failed to export settings');
  }
}
