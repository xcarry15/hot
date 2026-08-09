import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { formatToolSchemaError, toolDirectoryBackupSchema } from '@/lib/tool-directory-schema';
import { exportToolDirectoryBackup, restoreToolDirectoryBackup } from '@/lib/tool-directory-service';

const MAX_BACKUP_BYTES = 1_000_000;

export async function GET() {
  try {
    return NextResponse.json(await exportToolDirectoryBackup());
  } catch (error: unknown) {
    return apiError(error, '导出工具中心备份失败');
  }
}

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_BACKUP_BYTES) {
      return NextResponse.json({ error: '备份文件过大，最大支持 1MB' }, { status: 400 });
    }
    const parsed = toolDirectoryBackupSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: formatToolSchemaError(parsed.error) }, { status: 400 });
    }
    const result = await runExclusiveMutation('恢复工具中心备份', () => restoreToolDirectoryBackup(parsed.data));
    return NextResponse.json(result);
  } catch (error: unknown) {
    return apiError(error, '恢复工具中心备份失败');
  }
}
