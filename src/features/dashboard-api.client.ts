/**
 * Dashboard 客户端 API。
 */
import { requestJson } from '@/lib/request-json.client';

export interface DashboardData {
  // 由 /api/dashboard 决定；保留 unknown 让 UI 自己 narrow
  [key: string]: unknown;
}

export interface DedupStats {
  [key: string]: unknown;
}

export async function fetchDashboard(signal?: AbortSignal): Promise<DashboardData> {
  return requestJson<DashboardData>('GET', '/api/dashboard', { signal });
}

export async function fetchDedupStats(signal?: AbortSignal): Promise<DedupStats> {
  return requestJson<DedupStats>('GET', '/api/dedup-stats', { signal });
}
