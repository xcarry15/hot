/**
 * 飞书 transport：单 webhook 的 HTTP 请求 + 重试 + 失败解析。
 *
 * 与 delivery 解耦：本模块只关心「把卡片 POST 到一个 URL，得到 ok/not-ok 的事实」，
 * 不感知文章状态、PushLog 写入、并发去重。
 */
import { abortableDelay, withTimeout } from '@/lib/shared/async';
import { fetchSafe, readResponseText } from '@/lib/http';
import type { WebhookConfig } from '@/lib/settings';
import { assertNotAborted } from '@/lib/worker-stop';

/** 飞书 webhook 单次请求超时（10s）：webhook 偶发 hang 会让重试循环累计 36s，
 *  阻塞 cron。AbortController 强制结束单次请求。 */
export const PUSH_REQUEST_TIMEOUT_MS = 10_000;

/** 失败后退避：1s → 5s → 30s；
 *  循环 attempt ≤ delays.length，共 4 次尝试（初始 + 3 退避）。 */
const RETRY_DELAYS_MS = [1000, 5000, 30000];

export interface SingleWebhookPushResult {
  ok: boolean;
  retryCount: number;
  errorMessage?: string;
}

/**
 * 飞书 webhook 的 HTTP 2xx 只代表网关接收成功，业务层仍可能返回错误码。
 * 只有明确得到 code/StatusCode 为 0 才算投递成功；空响应或非 JSON 响应一律
 * 视为失败，避免把“业务拒绝”写成 PushDelivery succeeded。
 */
export function evaluateFeishuResponse(status: number, bodyText: string): {
  ok: boolean;
  errorMessage?: string;
} {
  const body = bodyText.trim();
  if (status < 200 || status >= 300) {
    return { ok: false, errorMessage: `HTTP ${status}: ${body.slice(0, 1000)}` };
  }
  if (!body) {
    return { ok: false, errorMessage: `Feishu HTTP ${status}: 响应体为空，缺少业务结果码` };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, errorMessage: `Feishu HTTP ${status}: 响应不是有效 JSON` };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errorMessage: `Feishu HTTP ${status}: 响应格式无效` };
  }

  const record = payload as Record<string, unknown>;
  const rawCode = record.code ?? record.StatusCode;
  const isSuccessCode = rawCode === 0 || (typeof rawCode === 'string' && rawCode.trim() === '0');
  if (isSuccessCode) return { ok: true };

  const message = record.msg ?? record.StatusMessage ?? record.message ?? '业务拒绝';
  return {
    ok: false,
    errorMessage: `Feishu HTTP ${status}: code=${String(rawCode ?? 'missing')}, msg=${String(message).slice(0, 900)}`,
  };
}

function classifyError(error: unknown): string {
  if (error instanceof Error && /timeout|aborted|aborterror/i.test(error.message)) {
    return `请求超时(${PUSH_REQUEST_TIMEOUT_MS / 1000}s)`;
  }
  return error instanceof Error ? error.message : 'Push request failed';
}

/**
 * 向单个 webhook 发送卡片，含固定退避重试。
 * 本函数只负责「拿到 ok」与「拿到 lastError」，不写 PushLog——由 delivery 决定如何记。
 */
export async function sendFeishuWebhook(
  config: WebhookConfig,
  card: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SingleWebhookPushResult> {
  let lastError = '';

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    assertNotAborted(signal);
    try {
      const response = await withTimeout(
        async (timeoutSignal) => {
          const rawResponse = await fetchSafe(config.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(card),
            signal: timeoutSignal,
          });
          const bodyText = await readResponseText(rawResponse);
          return { ok: rawResponse.ok, status: rawResponse.status, bodyText };
        },
        PUSH_REQUEST_TIMEOUT_MS,
        `Feishu webhook timeout: ${config.url}`,
        signal,
      );

      const evaluation = evaluateFeishuResponse(response.status, response.bodyText);
      if (response.ok && evaluation.ok) {
        return { ok: true, retryCount: attempt };
      }
      lastError = evaluation.errorMessage ?? `HTTP ${response.status}: webhook rejected`;
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      lastError = classifyError(error);
    }

    // Wait before retry
    if (attempt < RETRY_DELAYS_MS.length) {
      await abortableDelay(RETRY_DELAYS_MS[attempt], signal);
    }
  }

  return { ok: false, retryCount: RETRY_DELAYS_MS.length, errorMessage: lastError };
}
