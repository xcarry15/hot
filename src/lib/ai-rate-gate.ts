import { abortableDelay } from './shared/async';
import { isOpenCodeFreeModel, isOpenRouterFreeModel } from '@/contracts/ai-provider';

/**
 * OpenCode / OpenRouter 免费模型的进程内请求闸门。
 *
 * 这里只做客户端侧的保守保护；OpenCode 官方没有公布固定 RPM/TPM，
 * 不能把下面的间隔当作服务商配额承诺。
 * 单实例 PM2 / 单个开发进程内，同一 Provider 的免费请求共用一个时间序列，
 * 避免并发批次形成突发流量。
 */
// OpenRouter 免费层约 20 RPM；3 秒间隔贴近上限，同时保留统一串行队列。
export const OPENROUTER_FREE_REQUEST_INTERVAL_MS = 3_000;
export const OPENROUTER_FREE_COOLDOWN_MS = 60_000;
export const OPENCODE_FREE_REQUEST_INTERVAL_MS = 4_000;
export const OPENCODE_FREE_COOLDOWN_MS = 60_000;

type RateGateState = {
  nextRequestAt: number;
  cooldownUntil: number;
  requestQueue: Promise<void>;
};

const states = new Map<string, RateGateState>();

function getState(provider: string): RateGateState {
  const existing = states.get(provider);
  if (existing) return existing;
  const state: RateGateState = {
    nextRequestAt: 0,
    cooldownUntil: 0,
    requestQueue: Promise.resolve(),
  };
  states.set(provider, state);
  return state;
}

export function isFreeAIModel(provider: string, model: string): boolean {
  return (provider === 'openrouter' && isOpenRouterFreeModel(model))
    || (provider === 'opencode' && isOpenCodeFreeModel(model));
}

/** 等待免费模型的下一个请求时隙，并把并发调用排成单队列。 */
export function waitForAIRequestSlot(
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!isFreeAIModel(provider, model)) return Promise.resolve();

  const state = getState(provider);
  const intervalMs = provider === 'opencode'
    ? OPENCODE_FREE_REQUEST_INTERVAL_MS
    : OPENROUTER_FREE_REQUEST_INTERVAL_MS;

  const run = state.requestQueue.then(async () => {
    const waitUntil = Math.max(state.nextRequestAt, state.cooldownUntil);
    const waitMs = Math.max(0, waitUntil - Date.now());
    if (waitMs > 0) await abortableDelay(waitMs, signal);
    state.nextRequestAt = Date.now() + intervalMs;
  });

  // 某个调用被取消时，不能阻塞后续请求进入队列。
  state.requestQueue = run.catch(() => undefined);
  return run;
}

/** 收到 429 后暂停后续免费模型请求；调用方可用 Retry-After 覆盖默认冷却时间。 */
export function noteAIRateLimit(
  provider: string,
  model: string,
  retryAfterMs?: number,
): void {
  if (!isFreeAIModel(provider, model)) return;
  const state = getState(provider);
  const defaultCooldownMs = provider === 'opencode'
    ? OPENCODE_FREE_COOLDOWN_MS
    : OPENROUTER_FREE_COOLDOWN_MS;
  const cooldownMs = Math.max(defaultCooldownMs, retryAfterMs || 0);
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + cooldownMs);
  state.nextRequestAt = Math.max(state.nextRequestAt, state.cooldownUntil);
}

/** 返回免费模型当前剩余冷却时间；健康探测可据此快速失败，避免重复等待。 */
export function getAIRateLimitCooldownRemainingMs(provider: string, model: string): number {
  if (!isFreeAIModel(provider, model)) return 0;
  const state = states.get(provider);
  return state ? Math.max(0, state.cooldownUntil - Date.now()) : 0;
}

/** 仅供测试清理进程内状态。 */
export function resetAIRateGateForTests(): void {
  states.clear();
}
