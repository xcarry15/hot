import { db } from './db';

/** Provider 级错误的统一退避参数。Retry-After 更长时优先遵守上游时间。 */
export const AI_PROVIDER_RETRY_DELAY_MS = 2 * 60 * 1000;
export const AI_RATE_LIMIT_RETRY_DELAY_MS = 5 * 60 * 1000;
export const AI_PROVIDER_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export type AIProviderFailureKind = 'rate_limit' | 'provider' | 'network';

export interface AIProviderBackoffState {
  provider: string;
  cooldownUntil: Date | null;
  failureCount: number;
  lastErrorKind: string;
  lastStatus: number | null;
  lastRetryAfterMs: number | null;
}

type NoteAIProviderFailureInput = {
  kind: AIProviderFailureKind;
  status?: number;
  retryAfterMs?: number;
};

function normalizeRetryAfterMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.floor(value), AI_PROVIDER_MAX_BACKOFF_MS);
}

function calculateBackoffMs(kind: AIProviderFailureKind, failureCount: number, retryAfterMs?: number): number {
  const minimum = kind === 'rate_limit' ? AI_RATE_LIMIT_RETRY_DELAY_MS : AI_PROVIDER_RETRY_DELAY_MS;
  const exponential = Math.min(
    AI_PROVIDER_MAX_BACKOFF_MS,
    minimum * Math.pow(2, Math.max(0, failureCount - 1)),
  );
  return Math.min(
    AI_PROVIDER_MAX_BACKOFF_MS,
    Math.max(minimum, exponential, normalizeRetryAfterMs(retryAfterMs) || 0),
  );
}

function toState(row: {
  provider: string;
  cooldownUntil: Date | null;
  failureCount: number;
  lastErrorKind: string;
  lastStatus: number | null;
  lastRetryAfterMs: number | null;
}): AIProviderBackoffState {
  return row;
}

/** 读取持久化 Provider 状态，调用方在真正发请求前应快速失败。 */
export async function getAIProviderBackoff(provider: string): Promise<AIProviderBackoffState | null> {
  const row = await db.aiProviderState.findUnique({
    where: { provider },
    select: {
      provider: true,
      cooldownUntil: true,
      failureCount: true,
      lastErrorKind: true,
      lastStatus: true,
      lastRetryAfterMs: true,
    },
  });
  return row ? toState(row) : null;
}

/**
 * 记录一次 Provider 级限流、服务端或连接故障。状态按 Provider 聚合，服务重启后仍保留。
 * 只保存状态元数据，不保存上游响应正文或凭据。
 */
export async function noteAIProviderFailure(
  provider: string,
  input: NoteAIProviderFailureInput,
): Promise<AIProviderBackoffState> {
  const now = Date.now();
  const existing = await getAIProviderBackoff(provider);
  const failureCount = (existing?.failureCount || 0) + 1;
  const retryAfterMs = normalizeRetryAfterMs(input.retryAfterMs);
  const cooldownUntil = new Date(Math.max(
    existing?.cooldownUntil?.getTime() || 0,
    now + calculateBackoffMs(input.kind, failureCount, retryAfterMs),
  ));
  const row = await db.aiProviderState.upsert({
    where: { provider },
    create: {
      provider,
      cooldownUntil,
      failureCount,
      lastErrorKind: input.kind,
      lastStatus: input.status ?? null,
      lastRetryAfterMs: retryAfterMs ?? null,
    },
    update: {
      cooldownUntil,
      failureCount,
      lastErrorKind: input.kind,
      lastStatus: input.status ?? null,
      lastRetryAfterMs: retryAfterMs ?? null,
    },
    select: {
      provider: true,
      cooldownUntil: true,
      failureCount: true,
      lastErrorKind: true,
      lastStatus: true,
      lastRetryAfterMs: true,
    },
  });
  return toState(row);
}

/** 成功请求只清理已到期的旧退避，避免覆盖并发请求刚写入的新冷却。 */
export async function clearAIProviderBackoff(provider: string): Promise<void> {
  await db.aiProviderState.updateMany({
    where: {
      provider,
      failureCount: { gt: 0 },
      OR: [
        { cooldownUntil: null },
        { cooldownUntil: { lte: new Date() } },
      ],
    },
    data: {
      cooldownUntil: null,
      failureCount: 0,
      lastErrorKind: '',
      lastStatus: null,
      lastRetryAfterMs: null,
    },
  });
}
