export const DAY_MS = 24 * 60 * 60 * 1000;

export const DEDUP_CANDIDATE_CAP = 500;
export const DEDUP_DONE_CAP = 200;
export const DEDUP_AFTER_CAP = 100;

export function dedupWindowWhere(daysAgo: Date) {
  return {
    OR: [
      { publishedAt: { gte: daysAgo } },
      { publishedAt: null, createdAt: { gte: daysAgo } },
    ],
  };
}

/** 去重统一使用的有效时间：发布时间优先，抓取入库时间兜底。 */
export function effectiveArticleTime(article: { publishedAt: Date | null; createdAt: Date }): Date {
  return article.publishedAt ?? article.createdAt;
}

export function formatSharedValuesStr(count: number, values: string[], threshold?: number): string {
  const thresholdPart = threshold != null ? `阈值≥${threshold}个, ` : '';
  if (count === 0) return `${thresholdPart}命中0个数值`;
  const shown = values.length <= 10 ? values : values.slice(0, 10);
  const suffix = values.length <= 10 ? '' : '等';
  return `${thresholdPart}命中${count}个数值: ${shown.join(', ')}${suffix}`;
}
