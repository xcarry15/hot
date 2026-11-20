import { requireAdminAuth } from '@/lib/require-admin-auth';
import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getWorkQueueSummary } from '@/lib/work-queue-service';

export async function GET(request?: Request) {
  const denied = request ? requireAdminAuth(request as NextRequest) : null;
  if (denied) return denied;
  try {
    return NextResponse.json(await getWorkQueueSummary());
  } catch (error) {
    return apiError(error, '读取工作队列失败');
  }
}
