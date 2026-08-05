import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getPushLogStats } from '@/lib/push-log-service';

// GET /api/push-log/stats?startAt=...&endAt=... - Count grouped by source, webhookRemark, and status
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const startAt = parseDate(searchParams.get('startAt'));
    const endAt = parseDate(searchParams.get('endAt'));
    return NextResponse.json(await getPushLogStats(startAt, endAt));
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch push log stats');
  }
}

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
