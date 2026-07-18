import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getWorkQueueSummary } from '@/lib/work-queue-service';

export async function GET() {
  try {
    return NextResponse.json(await getWorkQueueSummary());
  } catch (error) {
    return apiError(error, '读取工作队列失败');
  }
}
