import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { clusterArticle } from '@/lib/event-clustering-service';

vi.mock('@/lib/event/event-recalculation-service', () => ({ recalculateEvent: vi.fn() }));
vi.mock('@/lib/public-publication-service', () => ({ refreshEventPublicPublication: vi.fn() }));

const now = new Date('2026-10-08T08:00:00Z');
const content = '手作奶茶品牌公布门店数量与排队时长。文章比较了几个品牌的经营数据和人工成本。'.repeat(10);
function article(overrides: Record<string, unknown> = {}) {
  return {
    id: 'new', title: '手作奶茶杀疯了！等一杯4小时，品牌却加速狂飙？',
    cleanContent: content, contentHash: '', eventSubjects: '[]', eventAction: '',
    eventObject: '', eventKey: '', eventKeyConfidence: 0, publishedAt: now,
    createdAt: now, aiStatus: 'done', clusterStatus: 'pending', ...overrides,
  };
}

describe('缺少单一事件身份的转载归并', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.$transaction).mockImplementation((async (operation: (client: typeof db) => Promise<unknown>) => operation(db)) as never);
    vi.mocked(db.article.findUnique).mockResolvedValue(article() as never);
    vi.mocked(db.event.findUnique).mockResolvedValue({ firstSeenAt: now, lastSeenAt: now } as never);
    vi.mocked(db.event.create).mockResolvedValue({ id: 'independent' } as never);
    vi.mocked(db.event.findMany).mockResolvedValue([{
      id: 'existing', representativeArticleId: 'old', clusterReviewStatus: 'confirmed',
      representativeArticle: article({ id: 'old', title: '手作奶茶杀疯了，等一杯4小时，品牌却加速狂飙？' }),
      articles: [],
    }] as never);
  });

  it('同标题近全文转载即使没有事件身份也归入已有Event', async () => {
    await expect(clusterArticle('new')).resolves.toEqual({ eventId: 'existing', action: 'attach' });
    expect(db.event.create).not.toHaveBeenCalled();
    expect(db.article.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventId: 'existing', clusterStatus: 'clustered' }),
    }));
  });

  it('同标题但正文不同的无身份稿保持独立，不以空eventKey作合并依据', async () => {
    vi.mocked(db.article.findUnique).mockResolvedValue(article({ cleanContent: '新的文章介绍消费者购买习惯，与旧稿事实完全不同。'.repeat(10) }) as never);
    await expect(clusterArticle('new')).resolves.toEqual({ eventId: 'independent', action: 'create' });
  });

  it('多事件快讯仍保持单篇独立，不并入一个子事件', async () => {
    vi.mocked(db.article.findUnique).mockResolvedValue(article({ title: '行业快讯：品牌A收购公司；品牌B上海首店开业' }) as never);
    await expect(clusterArticle('new')).resolves.toEqual({ eventId: 'independent', action: 'create' });
    expect(db.event.findMany).not.toHaveBeenCalled();
  });
});
