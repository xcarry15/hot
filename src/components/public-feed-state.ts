import type {
  PublicArticleDateGroupDto,
  PublicArticleListResponseDto,
} from '@/contracts/public-articles';

function countGroupItems(groups: PublicArticleDateGroupDto[]): number {
  return groups.reduce((total, group) => total + group.items.length, 0);
}

/** 合并同日期分页结果；优先侧的顺序和字段始终保留。 */
export function mergePublicArticleGroups(
  current: PublicArticleDateGroupDto[],
  incoming: PublicArticleDateGroupDto[],
  incomingFirst = false,
): PublicArticleDateGroupDto[] {
  const groups = new Map(current.map((group) => [group.date, group]));
  for (const group of incoming) {
    const existing = groups.get(group.date);
    if (!existing) {
      groups.set(group.date, group);
      continue;
    }

    const primary = incomingFirst ? group.items : existing.items;
    const secondary = incomingFirst ? existing.items : group.items;
    const seen = new Set<string>();
    const items = [...primary, ...secondary].filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    groups.set(group.date, { ...group, count: items.length, items });
  }
  return [...groups.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export function createPublicFeedState(
  data: PublicArticleListResponseDto,
  groups = data.groups,
): PublicArticleListResponseDto {
  return {
    ...data,
    groups,
    displayedArticleCount: countGroupItems(groups),
    displayedDateCount: groups.length,
  };
}

/** 刷新首页时用服务端最新数据覆盖同 id 的旧列表项，并保留已加载的旧分页。 */
export function mergeLatestPublicFeedState(
  current: PublicArticleListResponseDto,
  data: PublicArticleListResponseDto,
): PublicArticleListResponseDto {
  const groups = mergePublicArticleGroups(current.groups, data.groups, true);
  const hasLoadedOlderArticles = current.displayedArticleCount > data.displayedArticleCount;

  return createPublicFeedState({
    ...data,
    nextCursor: hasLoadedOlderArticles ? current.nextCursor : data.nextCursor,
    hasMore: hasLoadedOlderArticles ? current.hasMore : data.hasMore,
  }, groups);
}
