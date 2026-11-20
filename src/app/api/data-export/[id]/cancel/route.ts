import { requireAdminAuth } from '@/lib/require-admin-auth';
import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { cancelExportJob } from '@/lib/export/export-service';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const denied = request ? requireAdminAuth(request as NextRequest) : null;
  if (denied) return denied;
  try {
    const { id } = await context.params;
    return NextResponse.json({ job: await cancelExportJob(id) });
  } catch (error: unknown) {
    return apiError(error, '取消导出任务失败');
  }
}
