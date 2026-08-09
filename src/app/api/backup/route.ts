import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { exportProjectBackup, restoreProjectBackup } from '@/lib/backup-service';
import { runJob } from '@/lib/execution';
import { runExclusiveMutation } from '@/lib/mutation-guard';

const MAX_BACKUP_BYTES = 50_000_000;
const BACKUP_RESPONSE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
};

/** 导出内容包含明文密钥，使用 POST 避免被普通 GET 缓存或预取。 */
export async function POST() {
  try {
    return NextResponse.json(
      await runExclusiveMutation('导出完整备份', exportProjectBackup),
      { headers: BACKUP_RESPONSE_HEADERS },
    );
  } catch (error: unknown) {
    return apiError(error, '导出完整备份失败');
  }
}

export async function PUT(request: Request) {
  try {
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_BACKUP_BYTES) {
      return NextResponse.json({ error: '备份文件过大，最大支持 50MB' }, { status: 400 });
    }
    const payload = await request.json().catch(() => ({}));
    const result = await runExclusiveMutation('恢复完整备份', () => restoreProjectBackup(payload));

    let rebuildJobQueued = false;
    let rebuildDeferred = false;
    try {
      const rebuildJob = await runJob('full', {
        trigger: 'backup-restore',
        skipCollect: true,
        settingsRebuild: true,
      });
      rebuildJobQueued = rebuildJob.queued;
      rebuildDeferred = !rebuildJobQueued;
    } catch (error) {
      rebuildDeferred = true;
      console.error('[backup] rebuild wake-up failed; scheduler will retry:', error);
    }

    return NextResponse.json(
      { ...result, rebuildJobQueued, rebuildDeferred },
      { headers: BACKUP_RESPONSE_HEADERS },
    );
  } catch (error: unknown) {
    return apiError(error, '恢复完整备份失败');
  }
}
