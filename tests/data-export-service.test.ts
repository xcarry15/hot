import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exportJobFindUnique: vi.fn(),
  exportJobUpdateMany: vi.fn(),
  exportJobDeleteMany: vi.fn(),
  exportJobCreate: vi.fn(),
  exportJobFindMany: vi.fn(),
  exportJobFindFirst: vi.fn(),
  executeRaw: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    exportJob: {
      findUnique: mocks.exportJobFindUnique,
      updateMany: mocks.exportJobUpdateMany,
      deleteMany: mocks.exportJobDeleteMany,
      create: mocks.exportJobCreate,
      findMany: mocks.exportJobFindMany,
      findFirst: mocks.exportJobFindFirst,
    },
    $executeRawUnsafe: mocks.executeRaw,
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

import { cancelExportJob, createExportJob, deleteExportJob, runExportDataMaintenance, startExportWorker } from '@/lib/export/export-service';

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
    expect(mocks.exportJobDeleteMany).toHaveBeenCalledWith({ where: { id: 'job-1', status: 'succeeded' } });
    expect(mocks.exportJobUpdateMany).not.toHaveBeenCalled();
  });

  it('删除生成中的任务只请求取消，不与 Worker 并发删除文件或任务记录', async () => {
    mocks.exportJobFindUnique.mockResolvedValue({ ...succeededJob, status: 'running' });

    await expect(deleteExportJob('job-1')).rejects.toThrow('导出任务正在取消，请在任务结束后删除');

    expect(mocks.exportJobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'running' },
      data: { cancelRequestedAt: expect.any(Date) },
    });
    expect(mocks.exportJobDeleteMany).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it('删除排队任务先原子取消，再清理已无法被 Worker 认领的文件', async () => {
    mocks.exportJobFindUnique.mockResolvedValue({ ...succeededJob, status: 'queued' });

    await expect(deleteExportJob('job-1')).resolves.toBeUndefined();

    expect(mocks.exportJobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'queued' },
      data: { status: 'cancelled', completedAt: expect.any(Date), error: '已取消' },
    });
    expect(mocks.unlink).toHaveBeenCalledTimes(3);
    expect(mocks.exportJobDeleteMany).toHaveBeenCalledWith({ where: { id: 'job-1', status: 'cancelled' } });
  });
});

describe('导出快照准备与 Worker 认领', () => {
  let job: Record<string, unknown>;
  let resolveSnapshot: () => void;
  let rejectSnapshot: (error: Error) => void;

  beforeEach(() => {
    vi.resetAllMocks();
    job = {};
    mocks.unlink.mockResolvedValue(undefined);
    mocks.exportJobFindMany.mockResolvedValue([]);
    mocks.exportJobFindFirst.mockResolvedValue(null);
    mocks.exportJobCreate.mockImplementation(async ({ data }) => {
      job = {
        id: 'job-1', status: 'queued', createdAt: new Date(),
        cancelRequestedAt: null, expiresAt: null, startedAt: null, completedAt: null,
        ...data,
      };
      return { ...job };
    });
    mocks.exportJobFindUnique.mockImplementation(async () => ({ ...job }));
    mocks.exportJobUpdateMany.mockImplementation(async ({ where, data }) => {
      if (Object.entries(where).some(([key, value]) => job[key] !== value)) return { count: 0 };
      Object.assign(job, data);
      return { count: 1 };
    });
    mocks.executeRaw.mockImplementation(() => new Promise<void>((resolve, reject) => {
      resolveSnapshot = resolve;
      rejectSnapshot = reject;
    }));
  });

  it('快照未完成时已有 Worker 无法认领，完成后才原子入队', async () => {
    const pending = createExportJob({});
    await vi.waitFor(() => expect(mocks.executeRaw).toHaveBeenCalled());
    expect(job.status).toBe('running');
    expect(job.workerToken).toEqual(expect.any(String));

    startExportWorker();
    await vi.waitFor(() => expect(mocks.exportJobFindFirst).toHaveBeenCalled());
    expect(mocks.exportJobFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'queued' } }));
    expect(job.status).not.toBe('queued');

    resolveSnapshot();
    await expect(pending).resolves.toMatchObject({ status: 'queued' });
    expect(job.workerToken).toBe('');
    expect(job.startedAt).toBeNull();
    expect(mocks.unlink).toHaveBeenCalledTimes(1); // 创建前只清理旧快照，入队后不能再删除。
  });

  it('快照准备期间取消，完成后不得入队或覆盖取消结果', async () => {
    const pending = createExportJob({});
    const rejected = expect(pending).rejects.toThrow('导出任务已取消或正在清理');
    await vi.waitFor(() => expect(mocks.executeRaw).toHaveBeenCalled());
    await cancelExportJob('job-1');

    resolveSnapshot();
    await rejected;
    expect(job.status).toBe('cancelled');
    expect(job.workerToken).toBe('');
  });

  it('快照创建失败只更新仍由准备阶段持有的任务', async () => {
    const pending = createExportJob({});
    await vi.waitFor(() => expect(mocks.executeRaw).toHaveBeenCalled());
    job.status = 'cancelled';
    job.workerToken = '';

    rejectSnapshot(new Error('snapshot failed'));
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
    expect(job.status).toBe('cancelled');
  });

  it('入队后的响应读取失败不能清理 Worker 已可使用的快照', async () => {
    const pending = createExportJob({});
    const rejected = expect(pending).rejects.toThrow('read failed');
    await vi.waitFor(() => expect(mocks.executeRaw).toHaveBeenCalled());
    mocks.exportJobFindUnique.mockRejectedValueOnce(new Error('read failed'));

    resolveSnapshot();
    await rejected;
    expect(job.status).toBe('queued');
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
  });

  it('导出文件清理后，整个业务删除回调完成前仍拒绝创建快照', async () => {
    let finish!: () => void;
    let entered = false;
    const maintenance = runExportDataMaintenance(async () => {
      entered = true;
      await new Promise<void>((resolve) => { finish = resolve; });
      return 'done';
    });
    await vi.waitFor(() => expect(entered).toBe(true));

    await expect(createExportJob({})).rejects.toThrow('数据清理进行中');
    expect(mocks.exportJobCreate).not.toHaveBeenCalled();
    finish();
    await expect(maintenance).resolves.toBe('done');
  });

  it('清理前启动的快照在清理完成后返回也不能重新入队', async () => {
    const pending = createExportJob({});
    const rejected = expect(pending).rejects.toThrow('旧快照已取消');
    await vi.waitFor(() => expect(mocks.executeRaw).toHaveBeenCalled());
    await runExportDataMaintenance(async () => undefined);

    resolveSnapshot();
    await rejected;
    expect(job.status).toBe('cancelled');
  });

  it('业务删除失败也释放导出门禁，允许用户重新创建快照', async () => {
    await expect(runExportDataMaintenance(async () => { throw new Error('cleanup failed'); }))
      .rejects.toThrow('cleanup failed');

    const pending = createExportJob({});
    await vi.waitFor(() => expect(mocks.executeRaw).toHaveBeenCalled());
    resolveSnapshot();
    await expect(pending).resolves.toMatchObject({ status: 'queued' });
  });
});
