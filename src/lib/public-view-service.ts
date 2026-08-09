import { db } from '@/lib/db';
import { getPublicDateKey } from '@/lib/shared/public-date';
import { PUBLIC_INTERACTION_METRIC } from '@/contracts/state';

type PublicInteractionKind = 'view' | 'originalClick';

const MAX_INTERACTION_WRITE_ATTEMPTS = 3;

function isRetryableInteractionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|database is busy|SQLITE_BUSY|P1008|P2024/i.test(message);
}

function waitForRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, attempt * 25));
}

/**
 * 公开页面的 URL、权限和去重门禁都以 Event 为单位，因此互动也必须写到 Event。
 * 当前统计口径是 confirmed_request_count：一次通过 800ms 观察确认的浏览请求计数，
 * 不是 UV。Event 累计值服务工作台，按日表服务趋势分析；两者在同一事务中提交，
 * 避免出现总量与趋势分叉。
 * 每次请求在响应前写入同一个 SQLite 事务：这样进程重启不会像内存缓冲那样丢失
 * 最后几秒的浏览/点击；短暂写锁仅做有限重试。
 */
export async function recordPublicEventInteraction(
  eventId: string,
  sourceId: string,
  kind: PublicInteractionKind,
  now = new Date(),
): Promise<void> {
  void PUBLIC_INTERACTION_METRIC;
  const dateKey = getPublicDateKey(now);
  const eventIncrement = kind === 'view' ? { viewCount: { increment: 1 } } : { originalClickCount: { increment: 1 } };
  const dailyCreate = kind === 'view'
    ? { eventId, sourceId, dateKey, viewCount: 1, originalClickCount: 0 }
    : { eventId, sourceId, dateKey, viewCount: 0, originalClickCount: 1 };
  const dailyUpdate = kind === 'view'
    ? { viewCount: { increment: 1 } }
    : { originalClickCount: { increment: 1 } };

  for (let attempt = 1; attempt <= MAX_INTERACTION_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await db.$transaction([
        // Event 的累计值仅用于工作台详情；按日统计读取下方的不可回推事实表。
        db.event.update({ where: { id: eventId }, data: eventIncrement }),
        db.eventInteractionDaily.upsert({
          where: { eventId_sourceId_dateKey: { eventId, sourceId, dateKey } },
          create: dailyCreate,
          update: dailyUpdate,
        }),
      ]);
      return;
    } catch (error) {
      if (!isRetryableInteractionError(error) || attempt === MAX_INTERACTION_WRITE_ATTEMPTS) throw error;
      await waitForRetry(attempt);
    }
  }
}

export async function recordPublicEventView(eventId: string, sourceId: string): Promise<void> {
  await recordPublicEventInteraction(eventId, sourceId, 'view');
}

export async function recordPublicEventOriginalClick(eventId: string, sourceId: string): Promise<void> {
  await recordPublicEventInteraction(eventId, sourceId, 'originalClick');
}
