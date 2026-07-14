/**
 * Maintenance feature 的客户端 API 层（清理 / 维护操作）。
 *
 * 与 maintenance-service 的服务端契约一一对应：
 *   - GET /api/cleanup → getCleanupStats
 *   - POST /api/cleanup { action } → executeMaintenanceAction
 */
import { requestJson } from '@/lib/request-json.client';
import type { CleanupStats } from '@/lib/maintenance-service';

export async function fetchCleanupStats(signal?: AbortSignal): Promise<CleanupStats> {
  return requestJson<CleanupStats>('GET', '/api/cleanup', { signal });
}

export type MaintenanceAction =
  | 'purge-all'
  | 'all-articles'
  | 'low-quality'
  | 'pushed-articles'
  | 'dedup-logs'
  | 'fetch-logs'
  | 'reset-ai'
  | 'reset-ai-failed'
  | 'vacuum';

export async function executeMaintenanceAction(
  action: MaintenanceAction,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson('POST', '/api/cleanup', { body: { action }, signal });
}
