import type { AiTestResult } from '@/features/settings-api.client';
import { testSavedAiModel } from '@/features/settings-api.client';
import { isRequestAborted, isRequestJsonError } from '@/lib/request-json.client';
import { abortableDelay } from '@/lib/shared/async';

const STORAGE_KEY = 'hot2:openrouter-model-health:v1';

export interface ModelHealthResult extends AiTestResult {
  checkedAt: number;
}

export interface ModelHealthSnapshot {
  models: string[];
  completed: number;
  results: Record<string, ModelHealthResult>;
  cooldownUntil: number;
}

export function readModelHealth(): ModelHealthSnapshot {
  const empty: ModelHealthSnapshot = { models: [], completed: 0, results: {}, cooldownUntil: 0 };
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!value || !Array.isArray(value.models) || value.models.length > 51
      || !value.models.every((model: unknown) => typeof model === 'string' && model.length <= 200)
      || !Number.isInteger(value.completed) || value.completed < 0 || value.completed > value.models.length
      || !Number.isFinite(value.cooldownUntil) || !value.results || typeof value.results !== 'object') return empty;
    const results: Record<string, ModelHealthResult> = {};
    for (const [model, result] of Object.entries(value.results)) {
      const item = result as Partial<ModelHealthResult> | null;
      if (item && typeof item.success === 'boolean' && typeof item.checkedAt === 'number'
        && Number.isFinite(item.checkedAt)) results[model] = item as ModelHealthResult;
    }
    return { models: value.models, completed: value.completed, results, cooldownUntil: value.cooldownUntil };
  } catch {
    return empty;
  }
}

export function saveModelHealth(snapshot: ModelHealthSnapshot): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // 存储受限时仍可在当前页面完成检测。
  }
}

/** 一轮顺序探测；共享冷却不计作模型失败，不推进游标。 */
export async function pollModelHealth(
  initial: ModelHealthSnapshot,
  signal: AbortSignal,
  onChange: (snapshot: ModelHealthSnapshot, testingModel: string | null) => void,
  probe = testSavedAiModel,
): Promise<ModelHealthSnapshot> {
  let snapshot = { ...initial, results: { ...initial.results } };
  const publish = (model: string | null) => {
    saveModelHealth(snapshot);
    onChange(snapshot, model);
  };
  while (snapshot.completed < snapshot.models.length && !signal.aborted) {
    const remainingMs = snapshot.cooldownUntil - Date.now();
    if (remainingMs > 0) {
      publish(null);
      await abortableDelay(remainingMs, signal);
    }
    if (signal.aborted) break;
    const model = snapshot.models[snapshot.completed];
    publish(model);
    let result: AiTestResult;
    try {
      result = await probe('openrouter', model, signal);
    } catch (error) {
      if (signal.aborted || isRequestAborted(error)) break;
      // 浏览器到本站的失败不属于模型故障，保留游标供用户恢复。
      throw error;
    }
    if (signal.aborted) break;
    if (!result.success && result.errorKind === 'configuration') {
      throw new Error(result.error || '请检查已保存的 API Key 和账号配置');
    }
    const cooling = !result.success && ((result.retryAfterMs ?? 0) > 0
      || result.errorKind === 'rate_limit' || result.status === 429);
    if (!result.success && result.errorKind === 'network' && !cooling) {
      throw new Error(result.error || '网络不可用，请稍后继续检测');
    }
    snapshot = { ...snapshot, cooldownUntil: cooling ? Date.now() + Math.max(60_000, result.retryAfterMs ?? 0) : 0 };
    if (cooling && result.requestStarted === false) {
      publish(null);
      continue;
    }
    snapshot = {
      ...snapshot,
      completed: snapshot.completed + 1,
      results: { ...snapshot.results, [model]: { ...result, checkedAt: Date.now() } },
    };
    publish(null);
  }
  return snapshot;
}

export function healthProbeError(error: unknown): string {
  return isRequestJsonError(error) && error.status === 401
    ? '登录已失效，请重新登录后继续检测'
    : error instanceof Error ? error.message : '检测中断，可稍后继续';
}
