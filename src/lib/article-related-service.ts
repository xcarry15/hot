import { db } from '@/lib/db';
import { splitBrands } from '@/lib/shared/article-codecs';

const MAX_TAKE = 10;
const DEFAULT_TAKE = 5;
const RELATED_WINDOW_DAYS = 30;

type RelatedArticle = {
  id: string;
  title: string;
  summary: string;
  score: number;
  createdAt: Date;
  publishedAt: Date | null;
  aiStatus: string;
  brand: string;
};

function effectiveTime(article: Pick<RelatedArticle, 'publishedAt' | 'createdAt'>): number {
  return (article.publishedAt ?? article.createdAt).getTime();
}

/**
 * 相关动态是无向关系：任一文章的品牌出现在另一篇的品牌、标题或摘要中，双方都相关。
 * 这样 A -> B 的命中不会因为 B 的品牌字段不同而变成单向关系。
 */
function isRelatedPair(article: RelatedArticle, candidate: RelatedArticle): boolean {
  const articleBrands = splitBrands(article.brand);
  const candidateBrands = splitBrands(candidate.brand);

  const articleBrandInCandidate = articleBrands.some((brand) =>
    candidate.brand.includes(brand) || candidate.title.includes(brand) || candidate.summary.includes(brand),
  );
  const candidateBrandInArticle = candidateBrands.some((brand) =>
    article.title.includes(brand) || article.summary.includes(brand),
  );

  return articleBrandInCandidate || candidateBrandInArticle;
}

function compareByEffectiveTime(a: RelatedArticle, b: RelatedArticle): number {
  const timeDiff = effectiveTime(b) - effectiveTime(a);
  if (timeDiff !== 0) return timeDiff;
  return b.createdAt.getTime() - a.createdAt.getTime();
}

export async function getRelatedArticles(id: string, requestedTake: number) {
  const take = Number.isFinite(requestedTake) ? Math.min(Math.max(requestedTake, 1), MAX_TAKE) : DEFAULT_TAKE;
  const article = await db.article.findUnique({
    where: { id },
    select: { id: true, title: true, summary: true, brand: true, score: true, createdAt: true, publishedAt: true, aiStatus: true },
  });
  if (!article) return null;

  const brands = splitBrands(article.brand);

  const cutoff = new Date(Date.now() - RELATED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const brandMatch = brands.flatMap((brand) => [
    { brand: { contains: brand } },
    { title: { contains: brand } },
    { summary: { contains: brand } },
  ]);

  // 先取时间窗口内的候选，再在内存中做双向匹配；不能直接在数据库 take，
  // 否则 publishedAt 为空但 createdAt 更新的文章可能在排序后被截掉。
  const candidates = await db.article.findMany({
    where: {
      id: { not: id },
      aiStatus: { in: ['done', 'failed'] },
      AND: [
        {
          OR: [
            ...brandMatch,
            // 候选文章的品牌可能只出现在当前文章标题/摘要中，因此需要保留有品牌的候选。
            { brand: { not: '' } },
          ],
        },
        { OR: [{ publishedAt: { gte: cutoff } }, { publishedAt: null, createdAt: { gte: cutoff } }] },
      ],
    },
    select: { id: true, title: true, summary: true, score: true, createdAt: true, publishedAt: true, aiStatus: true, brand: true },
  });

  return candidates
    .filter((candidate) => isRelatedPair(article, candidate))
    .sort(compareByEffectiveTime)
    .slice(0, take)
    .map(({ id: articleId, title, score, createdAt, publishedAt, aiStatus, brand }) => ({
      id: articleId,
      title,
      score,
      createdAt,
      publishedAt,
      aiStatus,
      brand,
    }));
}
