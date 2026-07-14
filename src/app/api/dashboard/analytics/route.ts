import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import {
  type CrawlRecordFilters,
  getDashboardAnalytics,
  parseDashboardAnalyticsRange,
} from '@/lib/dashboard-analytics-service';

// GET /api/dashboard/analytics?range=today|3d|7d|30d&sourceId=...&crawlPage=1&crawlTrigger=auto&crawlStatus=completed&crawlType=full&crawlSourceId=...
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const range = parseDashboardAnalyticsRange(searchParams.get('range'));
    const sourceId = searchParams.get('sourceId') || undefined;
    const trigger = searchParams.get('crawlTrigger');
    const status = searchParams.get('crawlStatus') || undefined;
    const type = searchParams.get('crawlType');
    const crawlFilters: CrawlRecordFilters = {
      page: Number(searchParams.get('crawlPage')) > 0 ? Number(searchParams.get('crawlPage')) : 1,
      trigger: trigger === 'auto' || trigger === 'manual' || trigger === 'unknown' ? trigger : undefined,
      status: status && ['pending', 'running', 'completed', 'failed'].includes(status) ? status : undefined,
      type: type === 'full' || type === 'collect' ? type : undefined,
      sourceId: searchParams.get('crawlSourceId') || undefined,
    };
    return NextResponse.json(await getDashboardAnalytics(range, sourceId, crawlFilters));
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch dashboard analytics');
  }
}
