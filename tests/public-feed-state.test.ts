import { describe, expect, it } from 'vitest';
import { mergeLatestPublicFeedState, mergePublicArticleGroups } from '@/components/public-feed-state';
import type { PublicArticleListResponseDto } from '@/contracts/public-articles';

function item(id: string, title: string) {
  return {
    id,
    title,
    originalSource: null,
    excerpt: title,
    brand: '[]',
    category: '零售',
    score: 80,
    publishedAt: '2026-07-29T09:00:00.000Z',
    createdAt: '2026-07-29T09:00:00.000Z',
    sourceCount: 1,
    source: { id: 'source-1', name: '测试源', type: 'html' },
  };
}

function feed(items: ReturnType<typeof item>[], options: Partial<PublicArticleListResponseDto> = {}): PublicArticleListResponseDto {
  return {
    total: items.length,
    groups: [{ date: '2026-07-29', count: items.length, items }],
    displayedArticleCount: items.length,
    displayedDateCount: 1,
    nextCursor: null,
    hasMore: false,
    ...options,
  };
}

describe('公开文章列表状态合并', () => {
  it('刷新最新内容时以服务端结果覆盖同 id，并保持最新顺序', () => {
    const current = feed([item('old', '旧标题'), item('older', '旧文章'), item('oldest', '最早文章')], {
      nextCursor: 'older-cursor',
      hasMore: true,
    });
    const latest = feed([item('new', '新文章'), item('old', '已更新标题')]);

    const result = mergeLatestPublicFeedState(current, latest);

    expect(result.groups[0]?.items.map((value) => value.id)).toEqual(['new', 'old', 'older', 'oldest']);
    expect(result.groups[0]?.items.find((value) => value.id === 'old')?.title).toBe('已更新标题');
    expect(result.nextCursor).toBe('older-cursor');
    expect(result.hasMore).toBe(true);
  });

  it('加载更多时保留已显示文章的字段与顺序', () => {
    const result = mergePublicArticleGroups(
      feed([item('current', '当前标题')]).groups,
      feed([item('current', '旧副本'), item('older', '更早文章')]).groups,
    );

    expect(result[0]?.items.map((value) => value.id)).toEqual(['current', 'older']);
    expect(result[0]?.items[0]?.title).toBe('当前标题');
  });
});
