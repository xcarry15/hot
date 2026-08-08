import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { deleteExportJob, getExportJob } from '@/lib/export/export-service';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    return NextResponse.json({ job: await getExportJob(id) });
  } catch (error: unknown) {
    return apiError(error, '获取导出任务失败');
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    await deleteExportJob(id);
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    return apiError(error, '删除导出任务失败');
  }
}
