import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { readExportFile } from '@/lib/export/export-service';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const file = await readExportFile(id);
    return new NextResponse(file.buffer as BodyInit, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(file.fileName)}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error: unknown) {
    return apiError(error, '下载导出文件失败');
  }
}
