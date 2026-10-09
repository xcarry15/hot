import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { clusterArticle, findRecentPushedEventDuplicate } from '@/lib/event-clustering-service';

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

  it('精确命中的旧非代表成员超过最新12篇窗口时仍参与归并', async () => {
    const incoming = article({ contentHash: 'same-body' });
    const matched = article({ id: 'old-matched', contentHash: 'same-body', createdAt: new Date('2026-10-01') });
    const recent = Array.from({ length: 12 }, (_, i) => article({
      id: `recent-${i}`, title: `无关的新稿${i}`, cleanContent: '完全不同的主题与事实',
    }));
    vi.mocked(db.article.findUnique).mockResolvedValue(incoming as never);
    vi.mocked(db.event.findMany).mockImplementation((async (args: { select?: unknown }) => {
      // 模拟数据库：Event 因旧成员命中而被召回；关系投影决定是否带回旧成员。
      const select = args?.select as { articles?: { where?: { contentHash?: string } } };
      return [{
        id: 'existing', representativeArticleId: recent[0].id, clusterReviewStatus: 'confirmed',
        representativeArticle: recent[0], articles: select.articles?.where?.contentHash ? [matched] : recent,
      }] as never;
    }) as never);
    await expect(clusterArticle('new')).resolves.toEqual({ eventId: 'existing', action: 'attach' });
    expect(db.eventClusterAudit.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ evidence: expect.stringContaining('old-matched') }),
    }));
    await expect(findRecentPushedEventDuplicate('new', 'another-event')).resolves.toMatchObject({
      eventId: 'existing', evidence: { matchedMemberArticleId: 'old-matched', fingerprintMatch: true },
    });
  });

  it('高相似分但阶段冲突的15个候选不能挤掉同稿 exact 决策', async () => {
    const incoming = article({
      title: '测试品牌正式开业北京旗舰店', contentHash: 'same-body', eventKey: 'shared-key',
      eventSubjects: '["测试品牌"]', eventAction: '正式开业', eventObject: '北京旗舰店', eventKeyConfidence: 90,
    });
    vi.mocked(db.article.findUnique).mockResolvedValue(incoming as never);
    const exactMember = article({ id: 'exact-member', title: '转载标题不同', contentHash: 'same-body' });
    vi.mocked(db.event.findMany).mockResolvedValue([
      ...Array.from({ length: 15 }, (_, i) => ({
        id: `conflict-event-${i}`, representativeArticleId: `conflict-${i}`, clusterReviewStatus: 'confirmed',
        representativeArticle: {
          ...incoming, id: `conflict-${i}`, contentHash: `different-${i}`,
          title: '测试品牌计划开业北京旗舰店', eventAction: '计划开业',
        }, articles: [],
      })),
      { id: 'exact-event', representativeArticleId: exactMember.id, clusterReviewStatus: 'confirmed', representativeArticle: exactMember, articles: [] },
    ] as never);
    await expect(clusterArticle('new')).resolves.toEqual({ eventId: 'exact-event', action: 'attach' });
  });

  it('12篇较新的同key冲突稿不能挤掉较旧的同哈希强证据', async () => {
    const incoming = article({
      contentHash: 'same-body', eventKey: 'shared-key', eventSubjects: '["测试品牌"]',
      eventAction: '正式开业', eventObject: '北京旗舰店', eventKeyConfidence: 90,
    });
    const matched = { ...incoming, id: 'old-matched', createdAt: new Date('2026-10-01') };
    const members = [matched, ...Array.from({ length: 12 }, (_, i) => ({
      ...incoming, id: `conflict-${i}`, contentHash: `other-${i}`,
      title: '测试品牌计划开业', eventAction: '计划开业', cleanContent: '计划中的新店尚未开业',
      createdAt: new Date(now.getTime() + i),
    }))];
    vi.mocked(db.article.findUnique).mockResolvedValue(incoming as never);
    vi.mocked(db.event.findMany).mockImplementation((async (args: { select?: unknown }) => {
      // 按实际查询的 where/orderBy/take 筛选，防止 mock 隐藏窗口截断。
      const select = args?.select as { articles: { where: Record<string, unknown>; take: number } };
      const where = select.articles.where;
      const rows = members.filter((member) => {
        if (where.contentHash && member.contentHash !== where.contentHash) return false;
        if (where.eventKey && member.eventKey !== where.eventKey) return false;
        if (where.title && member.title !== where.title) return false;
        return true;
      }).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, select.articles.take);
      return rows.length ? [{
        id: 'existing', representativeArticleId: members[1].id, clusterReviewStatus: 'confirmed',
        representativeArticle: members[1], articles: rows,
      }] as never : [];
    }) as never);
    await expect(clusterArticle('new')).resolves.toEqual({ eventId: 'existing', action: 'attach' });
    expect(db.eventClusterAudit.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ evidence: expect.stringContaining('old-matched') }),
    }));
  });
});
