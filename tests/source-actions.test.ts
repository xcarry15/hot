import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { addPresetSources, createSource, retrySource } from '@/lib/source-actions';

const mocks = db as unknown as {
  source: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

const runJob = vi.hoisted(() => vi.fn());
vi.mock('@/lib/execution', () => ({ runJob }));
vi.mock('@/lib/pipeline/collect', () => ({ testCrawlSource: vi.fn() }));

describe('source-actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('创建来源复用统一 schema，并规范化持久化 parserConfig', async () => {
    mocks.source.create.mockResolvedValue({ id: 's1' });
    await expect(createSource({
      name: '  示例源  ',
      type: 'html',
      url: 'https://example.com/news',
      parserConfig: { itemSelector: '.item' },
      enabled: true,
      publicEnabled: false,
    })).resolves.toEqual({ source: { id: 's1' }, status: 201 });

    expect(mocks.source.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: '示例源',
        url: 'https://example.com/news',
        parserConfig: JSON.stringify({ itemSelector: '.item' }),
        publicEnabled: false,
      }),
    });
  });

  it('添加预设只创建缺失项，且默认保持禁用', async () => {
    mocks.source.findMany.mockResolvedValue([]);
    mocks.source.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: String(data.name), ...data }));
    mocks.$transaction.mockImplementation(async (operations: Array<Promise<unknown>>) => Promise.all(operations));

    const result = await addPresetSources({ addAll: true });

    expect(result.added).toBeGreaterThan(0);
    expect(mocks.source.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ enabled: false }),
    }));
  });

  it('重试来源只排队 collect Job，且并发冲突不伪装成功', async () => {
    mocks.source.findMany.mockResolvedValue([{ id: 's1' }]);
    runJob.mockResolvedValueOnce({ queued: true, jobId: 'j1' });
    await expect(retrySource({ sourceIds: ['s1'] })).resolves.toEqual({ queued: true, jobId: 'j1', sourceIds: ['s1'] });
    expect(runJob).toHaveBeenCalledWith('collect', {
      sourceIds: ['s1'], reason: 'retry', trigger: 'manual', resetSourceHealth: true,
    });

    runJob.mockResolvedValueOnce({ queued: false });
    await expect(retrySource({ sourceIds: ['s1'] })).resolves.toEqual({ queued: false, error: '已有抓取任务在执行中' });
  });
});
