import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { createExportJob, listExportJobs } from '@/lib/export/export-service';

export async function GET() {
  try {
    return NextResponse.json({ jobs: await listExportJobs() });
  } catch (error: unknown) {
    return apiError(error, '获取导出任务失败');
  }
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => ({}));
    const filter = body && typeof body === 'object' && 'filter' in body ? body.filter : body;
    return NextResponse.json({ job: await createExportJob(filter) }, { status: 201 });
  } catch (error: unknown) {
    return apiError(error, '创建导出任务失败');
  }
}
