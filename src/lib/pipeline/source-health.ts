/**
 * Source 健康状态（熔断 + 连续失败）助手。
 *
 * 单一职责：
 *   - `recordFailure`：单次抓取失败时累加 consecutiveFailures，写 fetchLog(failure)；
 *     阈值 ≥ 5 触发 6 小时熔断（breaker + circuitBreakerUntil）
 *   - `restoreBreakerIfElapsed`：熔断到期时清除熔断状态，让下次 cron 立即重新尝试
 *
 * 历史：
 *   - 逻辑原先内联在 `crawler.ts.recordFailure` 与 `collectAllSources`；
 *   - B12 抽离后保持语义完全一致：阈值、时长、字段值都不变。
 */
import { db } from '@/lib/db';
import type { Source } from '@prisma/client';

const FAILURE_BREAKER_THRESHOLD = 5;
const BREAKER_DURATION_MS = 6 * 60 * 60 * 1000; // 6 小时

/**
 * 累计 consecutiveFailures；阈值触发熔断；fetchLog 写入失败记录。
 * 若 source 不存在则静默返回。
 */
export async function recordFailure(sourceId: string, errorMessage: string): Promise<void> {
  const source = await db.source.findUnique({ where: { id: sourceId } });
  if (!source) return;

  const newFailCount = source.consecutiveFailures + 1;
  const shouldBreak = newFailCount >= FAILURE_BREAKER_THRESHOLD;

  await db.source.update({
    where: { id: sourceId },
    data: {
      consecutiveFailures: newFailCount,
      status: shouldBreak ? 'breaker' : 'warning',
      circuitBreakerUntil: shouldBreak
        ? new Date(Date.now() + BREAKER_DURATION_MS)
        : source.circuitBreakerUntil,
    },
  });

  await db.fetchLog.create({
    data: {
      sourceId,
      status: 'failure',
      errorMessage,
      itemsFound: 0,
    },
  });
}

/**
 * 熔断到期时复位 source 状态。返回是否被恢复（便于调用方编排事件）。
 */
export async function restoreBreakerIfElapsed(source: Source): Promise<boolean> {
  if (
    source.status === 'breaker' &&
    source.circuitBreakerUntil &&
    new Date() >= source.circuitBreakerUntil
  ) {
    await db.source.update({
      where: { id: source.id },
      data: { status: 'normal', consecutiveFailures: 0, circuitBreakerUntil: null },
    });
    return true;
  }
  return false;
}
