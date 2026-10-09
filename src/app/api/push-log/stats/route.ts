import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getPushLogStats } from '@/lib/push-log-service';
import { parseOptionalDate } from '@/lib/shared/date';

// GET /api/push-log/stats?startAt=...&endAt=... - Count grouped by source, webhookRemark, and status
export async function GET(request?: Request) {
  try {
    const searchParams = request ? new URL(request.url).searchParams : new URLSearchParams();
    const startAt = parseOptionalDate(searchParams.get('startAt'));
    const endAt = parseOptionalDate(searchParams.get('endAt'));
    return NextResponse.json(await getPushLogStats(startAt, endAt));
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch push log stats');
  }
}
