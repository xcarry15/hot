import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { EventCalibrationPanel } from '@/components/intelligence-inbox/event-calibration-panel';
import { getEventArticles } from '@/lib/event/event-query-service';

vi.mock('@/lib/push/delivery', () => ({ getPushTargetStates: vi.fn(async () => []) }));

describe('事件读取与操作边界', () => {
  it.each([false, true])('有事件时加载错误=%s，不显示重建入口', (eventLoadError) => {
    const props = {
      detail: { eventId: 'event-1', fetchStatus: 'fetched', aiStatus: 'done' },
      eventDetail: null,
      eventLoadError,
      onRetryEvent: vi.fn(),
    } as unknown as ComponentProps<typeof EventCalibrationPanel>;
    const html = renderToStaticMarkup(createElement(EventCalibrationPanel, props));
    expect(html).not.toContain('自动建立独立事件');
    expect(html).not.toContain('尚未归入 Event');
    expect(html).toContain(eventLoadError ? '重试' : '正在加载事件详情');
  });

  beforeEach(() => vi.clearAllMocks());

  it('事件窗口外代表仍补入，当前文章审计不被其他成员挤掉', async () => {
    const member = (id: string) => ({
      id, title: id, brand: '', publishedAt: null, createdAt: new Date('2026-10-01'),
      source: { name: '测试源', type: 'html', publicEnabled: true, deletedAt: null },
    });
    vi.mocked(db.event.findUnique).mockResolvedValue({
      id: 'event-1', articleCount: 402, representativeArticleId: 'old-representative',
      articles: [member('focused')], assignedAudits: [], pushedAt: null,
      firstSeenAt: new Date('2026-10-01'), lastSeenAt: new Date('2026-10-02'),
    } as never);
    vi.mocked(db.article.findFirst).mockResolvedValue(member('old-representative') as never);
    const result = await getEventArticles('event-1', 'focused');
    expect(result?.articles.map((article) => article.id)).toEqual(['focused', 'old-representative']);
    expect(result?.hasMoreArticles).toBe(true);
    expect(db.event.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ assignedAudits: expect.objectContaining({ where: { articleId: 'focused' } }) }),
    }));
  });
});
