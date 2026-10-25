// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import PublicArticleTimeline from '@/components/public-article-timeline';
import type { PublicArticleDateGroupDto, PublicArticleListItemDto } from '@/contracts/public-articles';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function article(id: string): PublicArticleListItemDto {
  return {
    id, title: `文章 ${id}`, originalSource: null, excerpt: '样例摘要', brand: '', category: '',
    score: 80, publishedAt: null, createdAt: '2026-10-25T08:00:00.000Z', sourceCount: 1,
    source: { id: 'source', name: '样例来源', type: 'rss' },
  };
}

function group(date: string, ids: string[]): PublicArticleDateGroupDto {
  return { date, count: ids.length, items: ids.map(article) };
}

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

async function render(groups: PublicArticleDateGroupDto[]) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<PublicArticleTimeline groups={groups} />));
  return container;
}

describe('公开日期分组的折叠边界', () => {
  it('收起使用原生 hidden，恢复后保留 Event 链接与 DOM', async () => {
    const container = await render([group('2026-10-25', ['event-1'])]);
    const button = container.querySelector('button')!;
    const list = container.querySelector('ol')!;
    const link = list.querySelector('a')!;
    expect(button.getAttribute('aria-controls')).toBe(list.id);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);
    expect(link.getAttribute('href')).toBe('/news/event-1');

    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(list.hidden).toBe(true);
    await act(async () => button.click());
    expect(list.hidden).toBe(false);
    expect(list.querySelector('a')).toBe(link);
  });

  it('分页追加同一天文章时保持收起，展开后展示新增文章且不影响其他日期', async () => {
    const first = group('2026-10-25', ['event-1']);
    const second = group('2026-10-24', ['event-2']);
    const container = await render([first, second]);
    await act(async () => container.querySelector('button')!.click());
    await act(async () => root!.render(<PublicArticleTimeline groups={[
      group(first.date, ['event-1', 'event-3']), second,
    ]} />));
    const lists = container.querySelectorAll('ol');
    expect(lists[0].hidden).toBe(true);
    expect(lists[1].hidden).toBe(false);
    await act(async () => container.querySelector('button')!.click());
    expect(lists[0].hidden).toBe(false);
    expect([...lists[0].querySelectorAll('a')].map((link) => link.getAttribute('href')))
      .toEqual(['/news/event-1', '/news/event-3']);
  });
});
