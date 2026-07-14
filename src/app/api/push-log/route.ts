import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { listPushLogs } from '@/lib/push-log-service';
import { parsePositiveInt } from '@/lib/pagination';

// GET /api/push-log - List push history
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parsePositiveInt(searchParams.get('page'), 1);
    const pageSize = parsePositiveInt(searchParams.get('pageSize'), 20, 100);
    const status = searchParams.get('status'); // success/failure
    const source = searchParams.get('source'); // source name
    const webhookRemark = searchParams.get('webhookRemark'); // webhook remark

    return NextResponse.json(await listPushLogs(page, pageSize, status, source, webhookRemark));
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch push logs');
  }
}
