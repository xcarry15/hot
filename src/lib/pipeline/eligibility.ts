import type { Prisma } from '@prisma/client';

/** 删除来源保留档案，但不再自动处理其遗留文章。 */
export const AUTOMATIC_ARTICLE_SOURCE_FILTER = {
  source: { is: { deletedAt: null } },
} satisfies Prisma.ArticleWhereInput;
