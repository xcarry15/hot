import { requireAdminAuth } from '@/lib/require-admin-auth';
import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { testWebhook } from '@/lib/webhook-test-service';

// POST /api/settings/test-webhook - Test Feishu webhook
export async function POST(request: Request) {
  const denied = request ? requireAdminAuth(request as NextRequest) : null;
  if (denied) return denied;
  try {
    const body = await request.json();
    const result = await testWebhook(body.webhookUrl);
    // testWebhook 的 error 可能包含上游响应正文（如飞书返回的错误 JSON）。
    // 只回传结论与 HTTP 状态，正文留在服务端日志，避免成为内部信息旁路。
    const safeResult: Record<string, unknown> = { success: result.success };
    if ('status' in result && typeof result.status === 'number') safeResult.status = result.status;
    if ('error' in result && typeof result.error === 'string' && result.error) {
      const httpStatus = /^HTTP (\d+):/.exec(result.error);
      safeResult.error = httpStatus
        ? `HTTP ${httpStatus[1]}: 上游服务返回错误（正文已省略）`
        : result.error;
    }
    return NextResponse.json(safeResult, 'status' in safeResult ? { status: safeResult.status as number } : undefined);
  } catch (error: unknown) {
    return apiError(error, 'Webhook test failed');
  }
}
