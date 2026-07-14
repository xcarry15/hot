import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getDedupStats } from '@/lib/dedup-stats-service';

/**
 * GET /api/dedup-stats
 *
 * Returns deduplication statistics for TODAY (not cumulative).
 * 去重事实分布在采集期 DiscardedItem 与 AI 前 Article.dedupDetail；本端点
 * 在服务层统一聚合，避免管理员看到阶段相关的统计缺口。
 *
 * - todayCount: deduped articles today
 * - allTimeTotal: cumulative total (for reference)
 * - byType: today's breakdown by dedup type (mapped back to
 *   url_exact / content_fingerprint / near_duplicate for frontend compatibility)
 *
 * Returns deduplication statistics for TODAY (not cumulative):
 * - todayCount: deduped articles today
 * - avgSimilarity: average similarity score for today's dedup records
 * - byType: today's breakdown by dedup type
 * - allTimeTotal: cumulative total (for reference)
 */
export async function GET() {
  try {
    return NextResponse.json(await getDedupStats());
  } catch (error) {
    console.error('[dedup-stats] Error:', error);
    return apiError(error, 'Failed to fetch dedup stats');
  }
}
