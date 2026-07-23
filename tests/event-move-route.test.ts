import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ moveArticleToEvent: vi.fn() }));

vi.mock('@/lib/event-service', () => ({ moveArticleToEvent: mocks.moveArticleToEvent }));
vi.mock('@/lib/mutation-guard', () => ({
  runExclusiveMutation: async (_label: string, action: () => unknown) => action(),
}));

import { POST } from '@/app/api/events/[id]/move/route';

describe('POST /api/events/[id]/move', () => {
  it('将路径 Event 作为文章移动的源边界传给服务层', async () => {
    mocks.moveArticleToEvent.mockResolvedValue(true);

    const response = await POST(
      new Request('http://localhost/api/events/source-event/move', {
        method: 'POST',
        body: JSON.stringify({ articleId: 'article-1', targetEventId: 'target-event' }),
      }),
      { params: Promise.resolve({ id: 'source-event' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.moveArticleToEvent).toHaveBeenCalledWith('source-event', 'article-1', 'target-event');
  });
});
