import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { listPushLogs } from '@/lib/push-log-service';
import { parsePositiveInt } from '@/lib/pagination';

// GET /api/push-log?startAt=...&endAt=... - List push history
export async function GET(request?: Request) {
  try {
    const searchParams = request ? new URL(request.url).searchParams : new URLSearchParams();
    const page = parsePositiveInt(searchParams.get('page'), 1);
    const pageSize = parsePositiveInt(searchParams.get('pageSize'), 20, 100);
    const status = searchParams.get('status'); // success/failure
    const source = searchParams.get('source'); // source name
    const webhookRemark = searchParams.get('webhookRemark'); // webhook remark
    const emptyWebhookRemark = searchParams.get('emptyWebhookRemark') === 'true';
    const startAt = parseDate(searchParams.get('startAt'));
    const endAt = parseDate(searchParams.get('endAt'));

    return NextResponse.json(await listPushLogs(page, pageSize, status, source, webhookRemark, emptyWebhookRemark, startAt, endAt));
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch push logs');
  }
}

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
