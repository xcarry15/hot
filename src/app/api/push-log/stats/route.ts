import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getPushLogStats } from '@/lib/push-log-service';

// GET /api/push-log/stats - Count grouped by source, webhookRemark, and status
export async function GET() {
  try {
    return NextResponse.json(await getPushLogStats());
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch push log stats');
  }
}
