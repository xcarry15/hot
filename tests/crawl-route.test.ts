import { beforeEach, describe, expect, it, vi } from 'vitest';

const runJob = vi.hoisted(() => vi.fn());

vi.mock('@/lib/execution', () => ({ runJob }));

import { POST } from '@/app/api/crawl/route';

describe('POST /api/crawl input boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runJob.mockResolvedValue({ queued: true, jobId: 'job-1' });
  });

  it('单源采集固定进入 collect Job，不能被 stage 参数扩大为全流程', async () => {
    const res = await POST(new Request('http://localhost/api/crawl', {
      method: 'POST',
      body: JSON.stringify({ sourceId: 'source-1', stage: 'all' }),
    }));
    expect(res.status).toBe(200);
    expect(runJob).toHaveBeenCalledWith('collect', { sourceId: 'source-1', trigger: 'manual' });
  });

  it('拒绝空 sourceId 与未知 stage，不静默降级为全流程', async () => {
    const emptySource = await POST(new Request('http://localhost/api/crawl', {
      method: 'POST', body: JSON.stringify({ sourceId: {} }),
    }));
    expect(emptySource.status).toBe(400);

    const unknownStage = await POST(new Request('http://localhost/api/crawl', {
      method: 'POST', body: JSON.stringify({ stage: 'everything' }),
    }));
    expect(unknownStage.status).toBe(400);
    expect(runJob).not.toHaveBeenCalled();
  });

  it('支持单独运行事件聚类阶段', async () => {
    const res = await POST(new Request('http://localhost/api/crawl', {
      method: 'POST', body: JSON.stringify({ stage: 'cluster' }),
    }));
    expect(res.status).toBe(200);
    expect(runJob).toHaveBeenCalledWith('cluster', { trigger: 'manual' });
  });
});
