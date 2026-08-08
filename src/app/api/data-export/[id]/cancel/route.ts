import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { cancelExportJob } from '@/lib/export/export-service';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    return NextResponse.json({ job: await cancelExportJob(id) });
  } catch (error: unknown) {
    return apiError(error, '取消导出任务失败');
  }
}
