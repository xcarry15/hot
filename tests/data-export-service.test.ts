import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exportJobFindUnique: vi.fn(),
  exportJobUpdateMany: vi.fn(),
  exportJobDeleteMany: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    exportJob: {
      findUnique: mocks.exportJobFindUnique,
      updateMany: mocks.exportJobUpdateMany,
      deleteMany: mocks.exportJobDeleteMany,
    },
  },
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  unlink: mocks.unlink,
  writeFile: vi.fn(),
}));

import { deleteExportJob } from '@/lib/export/export-service';

const succeededJob = {
  id: 'job-1',
  status: 'succeeded',
  storageKey: '00000000-0000-0000-0000-000000000001.xlsx',
};

describe('Excel 导出任务服务', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exportJobFindUnique.mockResolvedValue(succeededJob);
    mocks.exportJobUpdateMany.mockResolvedValue({ count: 1 });
    mocks.exportJobDeleteMany.mockResolvedValue({ count: 1 });
    mocks.unlink.mockResolvedValue(undefined);
  });

  it('删除任务时同时清理工作簿、临时文件和快照', async () => {
    await expect(deleteExportJob('job-1')).resolves.toBeUndefined();

    expect(mocks.unlink).toHaveBeenCalledTimes(3);
    expect(mocks.exportJobDeleteMany).toHaveBeenCalledWith({ where: { id: 'job-1' } });
    expect(mocks.exportJobUpdateMany).not.toHaveBeenCalled();
  });

  it('删除生成中的任务前先发出取消信号', async () => {
    mocks.exportJobFindUnique.mockResolvedValue({ ...succeededJob, status: 'running' });

    await deleteExportJob('job-1');

    expect(mocks.exportJobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'running' },
      data: { cancelRequestedAt: expect.any(Date) },
    });
    expect(mocks.exportJobDeleteMany).toHaveBeenCalledWith({ where: { id: 'job-1' } });
  });
});
