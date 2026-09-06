import { fetchSafe, readResponseText } from '@/lib/http';
import { withTimeout } from '@/lib/shared/async';

export interface ModelCatalogResponse {
  ok: boolean;
  status: number;
  payload?: unknown;
}

/**
 * 模型发现的共享 HTTP Adapter。
 * Provider 只负责解析自己的目录格式和免费模型策略。
 */
export async function fetchModelCatalog(
  url: string,
  timeoutMessage: string,
): Promise<ModelCatalogResponse> {
  const response = await withTimeout(
    (signal) => fetchSafe(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal,
    }),
    10_000,
    timeoutMessage,
  );

  if (!response.ok) return { ok: false, status: response.status };
  return {
    ok: true,
    status: response.status,
    payload: JSON.parse(await readResponseText(response)),
  };
}
