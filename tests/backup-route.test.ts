import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exportProjectBackup: vi.fn(),
  restoreProjectBackup: vi.fn(),
  runJob: vi.fn(),
  runExclusiveMutation: vi.fn(),
}));

vi.mock('@/lib/backup-service', () => ({
  exportProjectBackup: mocks.exportProjectBackup,
  restoreProjectBackup: mocks.restoreProjectBackup,
}));

vi.mock('@/lib/execution', () => ({ runJob: mocks.runJob }));

vi.mock('@/lib/mutation-guard', () => ({
  runExclusiveMutation: mocks.runExclusiveMutation,
  MutationConflictError: class MutationConflictError extends Error {},
}));

import { POST, PUT } from '@/app/api/backup/route';

describe('完整备份 API 边界', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runExclusiveMutation.mockImplementation(async (_name: string, operation: () => unknown) => operation());
    mocks.exportProjectBackup.mockResolvedValue({ type: 'hot2-project-backup', settings: { deepseek_api_key: 'secret' } });
    mocks.restoreProjectBackup.mockResolvedValue({ summary: { settings: 1 }, rebuildQueued: true });
    mocks.runJob.mockResolvedValue({ queued: true, jobId: 'rebuild-job' });
  });

  it('导出与恢复响应都显式禁止缓存', async () => {
    const exported = await POST();
    const restored = await PUT(new Request('http://localhost/api/backup', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backup: true }),
    }));

    expect(exported.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(restored.headers.get('Cache-Control')).toBe('no-store, max-age=0');
  });

  it('恢复校验失败时不触发后续重建任务', async () => {
    mocks.restoreProjectBackup.mockRejectedValue(Object.assign(new Error('备份文件格式无效'), { status: 400, exposeToClient: true }));

    const response = await PUT(new Request('http://localhost/api/backup', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid: true }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.runJob).not.toHaveBeenCalled();
  });
});
