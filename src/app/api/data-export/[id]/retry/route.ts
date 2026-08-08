import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { retryExportJob } from '@/lib/export/export-service';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    return NextResponse.json({ job: await retryExportJob(id) }, { status: 201 });
  } catch (error: unknown) {
    return apiError(error, '重试导出任务失败');
  }
}
