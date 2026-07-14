/**
 * GET /api/crawl-log/status
 *
 * 重构 #4：抓取记录页唯一权威接口。
 *
 * Route 仅做：
 *   - 解析 query `limit`
 *   - 调用 `crawl-log-service.getCrawlLogSnapshot()`
 *   - 设置禁缓存头，返回 JSON
 *
 * 关键不变量由 service 保证：
 *   - activeJob 只取 status='running' 最新一条（多条时记服务端告警）。
 *   - Job.payload/result 安全解析；非法 JSON 返回 null，不让整个 snapshot 500。
 *   - Articles / DiscardedItems / Job 用一次 Prisma $transaction。
 *   - 上限 500，按 publishedAt desc → createdAt desc 排序。
 *   - 响应禁缓存：Next.js / 代理不得返回旧任务状态。
 */
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { clampCrawlLogLimit, getCrawlLogSnapshot } from '@/lib/crawl-log-service';
import { parsePositiveInt } from '@/lib/pagination';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = clampCrawlLogLimit(parsePositiveInt(searchParams.get('limit'), 500, 500));

    const snapshot = await getCrawlLogSnapshot({ limit });

    return NextResponse.json(snapshot, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      },
    });
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch crawl-log snapshot');
  }
}
