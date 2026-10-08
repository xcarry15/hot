import type { Prisma } from '@prisma/client';
import { LOW_ANALYSIS_CONFIDENCE_FILTER } from '@/contracts/ai-confidence';

export const CLUSTER_REVIEW_FILTER = { clusterStatus: 'needs_review' } satisfies Prisma.ArticleWhereInput;
export const HUMAN_ATTENTION_FILTER = {
  OR: [CLUSTER_REVIEW_FILTER, LOW_ANALYSIS_CONFIDENCE_FILTER],
} satisfies Prisma.ArticleWhereInput;
