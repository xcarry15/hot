import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { refreshPublicPublication } from '@/lib/public-publication-service';

const mocks = db as unknown as {
  article: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  event: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  setting: { findUnique: ReturnType<typeof vi.fn> };
};

describe('public-publication-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.article.update.mockResolvedValue({});
    mocks.event.findUnique.mockResolvedValue({
      representativeArticleId: 'a1',
      publicStatus: 'unpublished',
      publicPublishedAt: null,
    });
    mocks.event.update.mockResolvedValue({});
    mocks.setting.findUnique
      .mockResolvedValueOnce({ value: '70' })
      .mockResolvedValueOnce({ value: 'true' });
  });

  it('符合规则的文章会被持久化标记为已发布', async () => {
    mocks.article.findUnique.mockResolvedValue({
      id: 'a1',
      eventId: 'e1',
      clusterStatus: 'clustered',
      aiStatus: 'done',
      score: 82,
      isAd: false,
      publicOverride: 'auto',
      publicStatus: 'unpublished',
      publicPublishedAt: null,
      publicRevokedAt: null,
      publicContentUpdatedAt: null,
      source: { publicEnabled: true, deletedAt: null },
    });

    await expect(refreshPublicPublication('a1')).resolves.toBe(true);

    expect(mocks.article.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a1' },
      data: expect.objectContaining({
        publicStatus: 'published',
        publicPublicationReason: 'eligible',
        publicRevokedAt: null,
      }),
    }));
  });

  it('规则不再满足时会持久化撤回状态', async () => {
    mocks.article.findUnique.mockResolvedValue({
      id: 'a1',
      eventId: 'e1',
      clusterStatus: 'clustered',
      aiStatus: 'done',
      score: 62,
      isAd: false,
      publicOverride: 'auto',
      publicStatus: 'published',
      publicPublishedAt: new Date('2026-07-15T00:00:00.000Z'),
      publicRevokedAt: null,
      publicContentUpdatedAt: new Date('2026-07-15T00:00:00.000Z'),
      source: { publicEnabled: true, deletedAt: null },
    });

    await expect(refreshPublicPublication('a1')).resolves.toBe(true);

    expect(mocks.article.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        publicStatus: 'revoked',
        publicPublicationReason: 'score-below-threshold',
      }),
    }));
  });

  it.each([
    ['AI 未完成', { aiStatus: 'pending' }, 'ai-not-done'],
    ['数据源关闭', { source: { publicEnabled: false, deletedAt: null } }, 'source-disabled'],
    ['人工隐藏', { publicOverride: 'hidden' }, 'manual-hidden'],
  ])('%s 时不会继续公开', async (_label, overrides, reason) => {
    mocks.article.findUnique.mockResolvedValue({
      id: 'a1',
      eventId: 'e1',
      clusterStatus: 'clustered',
      aiStatus: 'done',
      score: 82,
      isAd: false,
      publicOverride: 'auto',
      publicStatus: 'published',
      publicPublishedAt: new Date('2026-07-15T00:00:00.000Z'),
      publicRevokedAt: null,
      publicContentUpdatedAt: new Date('2026-07-15T00:00:00.000Z'),
      source: { publicEnabled: true, deletedAt: null },
      ...overrides,
    });

    await expect(refreshPublicPublication('a1')).resolves.toBe(true);

    expect(mocks.article.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        publicStatus: 'revoked',
        publicPublicationReason: reason,
      }),
    }));
  });

  it('人工公开可绕过最低分和软文规则', async () => {
    mocks.setting.findUnique
      .mockReset()
      .mockResolvedValueOnce({ value: '95' })
      .mockResolvedValueOnce({ value: 'true' });
    mocks.article.findUnique.mockResolvedValue({
      id: 'a1',
      eventId: 'e1',
      clusterStatus: 'clustered',
      aiStatus: 'done',
      score: 20,
      isAd: true,
      publicOverride: 'public',
      publicStatus: 'revoked',
      publicPublishedAt: new Date('2026-07-15T00:00:00.000Z'),
      publicRevokedAt: new Date('2026-07-15T01:00:00.000Z'),
      publicContentUpdatedAt: new Date('2026-07-15T00:00:00.000Z'),
      source: { publicEnabled: true, deletedAt: null },
    });

    await expect(refreshPublicPublication('a1')).resolves.toBe(true);

    expect(mocks.article.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        publicStatus: 'published',
        publicPublicationReason: 'eligible',
        publicRevokedAt: null,
      }),
    }));
  });

  it('已发布文章内容变化时刷新公开内容时间轴', async () => {
    const previous = new Date('2026-07-15T00:00:00.000Z');
    mocks.article.findUnique.mockResolvedValue({
      id: 'a1',
      eventId: 'e1',
      clusterStatus: 'clustered',
      aiStatus: 'done',
      score: 82,
      isAd: false,
      publicOverride: 'auto',
      publicStatus: 'published',
      publicPublishedAt: previous,
      publicRevokedAt: null,
      publicContentUpdatedAt: previous,
      source: { publicEnabled: true, deletedAt: null },
    });

    await refreshPublicPublication('a1', db, { contentChanged: true });

    const data = mocks.article.update.mock.calls[0][0].data;
    expect(data.publicContentUpdatedAt).toBeInstanceOf(Date);
    expect(data.publicContentUpdatedAt.getTime()).toBeGreaterThan(previous.getTime());
  });
});
