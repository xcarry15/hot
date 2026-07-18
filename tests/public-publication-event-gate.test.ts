import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleFindUnique: vi.fn(),
  articleUpdate: vi.fn(),
  eventFindUnique: vi.fn(),
  eventUpdate: vi.fn(),
  settingFindUnique: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    article: { findUnique: mocks.articleFindUnique, update: mocks.articleUpdate },
    event: { findUnique: mocks.eventFindUnique, update: mocks.eventUpdate },
    setting: { findUnique: mocks.settingFindUnique },
  },
}));

import { refreshPublicPublication } from '@/lib/public-publication-service';

describe('公开状态 Event 门禁', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingFindUnique.mockResolvedValue(null);
    mocks.articleUpdate.mockResolvedValue({});
  });

  it('未归属 Event 的 Article 即使人工公开也不能发布', async () => {
    mocks.articleFindUnique.mockResolvedValue({
      id: 'a1', eventId: null, clusterStatus: 'pending', aiStatus: 'done', score: 100,
      isAd: false, publicOverride: 'public', publicStatus: 'unpublished',
      publicPublishedAt: null, publicRevokedAt: null, publicContentUpdatedAt: null,
      source: { publicEnabled: true, deletedAt: null },
    });
    await refreshPublicPublication('a1');
    expect(mocks.articleUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ publicStatus: 'unpublished', publicPublicationReason: 'event-not-ready' }),
    }));
    expect(mocks.eventUpdate).not.toHaveBeenCalled();
  });
});
