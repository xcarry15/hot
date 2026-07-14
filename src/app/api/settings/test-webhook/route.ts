import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { testWebhook } from '@/lib/webhook-test-service';

// POST /api/settings/test-webhook - Test Feishu webhook
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await testWebhook(body.webhookUrl);
    return NextResponse.json(result, 'status' in result ? { status: result.status } : undefined);
  } catch (error: unknown) {
    return apiError(error, 'Webhook test failed');
  }
}
