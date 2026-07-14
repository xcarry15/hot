/**
 * 飞书 transport：单 webhook 的 HTTP 请求 + 重试 + 失败解析。
 *
 * 与 delivery 解耦：本模块只关心「把卡片 POST 到一个 URL，得到 ok/not-ok 的事实」，
 * 不感知文章状态、PushLog 写入、并发去重。
 */
import { abortableDelay, withTimeout } from '@/lib/shared/async';
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
          const rawResponse = await fetch(config.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(card),
            signal: timeoutSignal,
          });
          const bodyText = rawResponse.ok ? '' : await rawResponse.text();
          return { ok: rawResponse.ok, status: rawResponse.status, bodyText };
        },
        PUSH_REQUEST_TIMEOUT_MS,
        `Feishu webhook timeout: ${config.url}`,
        signal,
      );

      if (response.ok) {
        return { ok: true, retryCount: attempt };
      }
      lastError = `HTTP ${response.status}: ${response.bodyText}`;
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
