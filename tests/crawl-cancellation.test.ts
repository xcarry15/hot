import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { JobLeaseLostError, runWithJobLease } from '@/lib/job-context';

const mocks = vi.hoisted(() => ({
  parse: vi.fn(), enrich: vi.fn(), needsDetail: vi.fn(),
  source: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  article: { findMany: vi.fn(), create: vi.fn() },
  discardedItem: { findMany: vi.fn() },
  job: { findUnique: vi.fn() },
  fetchLog: { create: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ db: {
  source: mocks.source, article: mocks.article, discardedItem: mocks.discardedItem,
  job: mocks.job, fetchLog: mocks.fetchLog,
} }));
vi.mock('@/lib/parser-registry', () => ({ dispatchParser: mocks.parse }));
vi.mock('@/lib/parser-html', () => ({ enrichDetailPublishedAt: mocks.enrich, sourceNeedsDetailPublishedAt: mocks.needsDetail }));
import { crawlSource } from '@/lib/pipeline/collect';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(db.source.findUnique).mockResolvedValue({
    id: 's1', name: '测试来源', enabled: true, status: 'normal', type: 'rss',
    url: 'https://example.com', parserConfig: '{}', circuitBreakerUntil: null,
  } as never);
  vi.mocked(db.job.findUnique).mockResolvedValue({
    status: 'running', leaseOwner: 'owner1', leaseExpiresAt: new Date(Date.now() + 60_000),
  } as never);
  vi.mocked(db.source.findMany).mockResolvedValue([]);
  vi.mocked(db.article.findMany).mockResolvedValue([]);
  vi.mocked(db.discardedItem.findMany).mockResolvedValue([]);
  mocks.needsDetail.mockReturnValue(false);
});

describe('数据源迟到响应', () => {
  it.each([true, false])('解析结果 success=%s 返回时执行权已丢失，不写来源健康或文章', async (success) => {
    mocks.parse.mockResolvedValue({ success, items: [], error: success ? undefined : 'late source failure' });
    await expect(runWithJobLease({ jobId: 'j1', owner: 'owner1' }, () => crawlSource('s1'), async () => false))
      .rejects.toBeInstanceOf(JobLeaseLostError);
    expect(db.source.update).not.toHaveBeenCalled();
    expect(db.fetchLog.create).not.toHaveBeenCalled();
    expect(db.article.create).not.toHaveBeenCalled();
  });

  it('可选详情日期补全期间执行权交接，不继续写入新文章或误记来源失败', async () => {
    let current = true;
    mocks.parse.mockResolvedValue({ success: true, items: [{ title: '合成标题', url: 'https://example.com/new' }] });
    mocks.needsDetail.mockReturnValue(true);
    mocks.enrich.mockImplementation(async () => { current = false; });
    await expect(runWithJobLease({ jobId: 'j1', owner: 'owner1' }, () => crawlSource('s1'), async () => current))
      .rejects.toBeInstanceOf(JobLeaseLostError);
    expect(mocks.enrich).toHaveBeenCalledOnce();
    expect(db.article.create).not.toHaveBeenCalled();
    expect(db.source.update).toHaveBeenCalledOnce();
    expect(db.fetchLog.create).toHaveBeenCalledOnce();
    expect(db.fetchLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'success' }) }));
  });
});
