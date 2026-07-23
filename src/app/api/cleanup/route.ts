/**
 * Cleanup Route 适配器。
 *
 * 只保留：解析 action 字符串 → 调用 `maintenance-service` 用例 → 映射响应。
 * 任何事务、清理策略、统计查询都不得在此文件中实现。
 */
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import {
  executeMaintenanceAction,
  getCleanupStats,
  type MaintenanceAction,
} from '@/lib/maintenance-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';

const KNOWN_ACTIONS = [
  'purge-all',
  'all-articles',
  'low-quality',
  'pushed-articles',
  'dedup-logs',
  'fetch-logs',
  'reset-ai',
  'reset-ai-failed',
  'vacuum',
] as const;

/**
 * GET /api/cleanup - Get counts of each data category for preview
 */
export async function GET() {
  try {
    return NextResponse.json(await getCleanupStats());
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch cleanup stats');
  }
}

/**
 * POST /api/cleanup - Execute cleanup actions
 * Body: { action: string }
 *
 * Actions:
 * - purge-all: ⚠️ 清空所有业务数据（Article/PushLog/DiscardedItem/FetchLog/Job），保留 Source/Keyword/Setting
 * - all-articles: Delete ALL articles (and their push logs)
 * - low-quality: Delete articles with score < 40
 * - pushed-articles: Delete articles that have been pushed
 * - dedup-logs: Clear dedup-type discarded records
 * - fetch-logs: Clear all fetch logs
 * - reset-ai: Reset all articles' AI status to pending
 * - reset-ai-failed: Reset only technical AI failures to pending
 * - vacuum: 压缩数据库文件，回收 DELETE 后未释放的磁盘空间
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action } = body;

    if (!action || !(KNOWN_ACTIONS as readonly string[]).includes(action)) {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }

    const result = await runExclusiveMutation(`数据清理（${action}）`, () =>
      executeMaintenanceAction(action as MaintenanceAction),
    );
    return NextResponse.json(result);
  } catch (error: unknown) {
    return apiError(error, 'Cleanup failed');
  }
}
