import type { Prisma } from '@prisma/client';

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24_000);
}

/**
 * 文章列表搜索直接使用 Article 已有字段。
 * 当前数据规模下，派生 searchText 只增加同步写入和一致性风险，并没有提供真正的 FTS 索引。
 */
export function buildArticleSearchWhere(search: string): Prisma.ArticleWhereInput {
  const normalized = normalizeSearchText(search);
  if (!normalized) return {};
  return {
    OR: [
      { title: { contains: normalized } },
      { cleanContent: { contains: normalized } },
      { summary: { contains: normalized } },
      { brand: { contains: normalized } },
      { eventKey: { contains: normalized } },
    ],
  };
}
