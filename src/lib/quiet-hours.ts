/**
 * 自动化任务的免打扰时段。
 *
 * 时间按业务约定使用 Asia/Shanghai，不依赖服务器所在时区。无效配置和
 * 起止时间相同均按“未配置免打扰”处理，避免错误设置把自动化永久锁死。
 */
export const SCHEDULER_TIME_ZONE = 'Asia/Shanghai';
export const DEFAULT_QUIET_START = '22:00';
export const DEFAULT_QUIET_END = '08:00';

export function parseTimeOfDay(value: string | null | undefined): number | null {
  const match = (value ?? '').trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function getZonedMinutes(
  now = new Date(),
  timeZone = SCHEDULER_TIME_ZONE,
): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return Number(values.hour) * 60 + Number(values.minute);
}

/** 是否处于 [start, end) 免打扰区间，支持跨午夜配置。 */
export function isWithinQuietHours(
  now: Date,
  start: string | null | undefined,
  end: string | null | undefined,
  timeZone = SCHEDULER_TIME_ZONE,
): boolean {
  const startMinutes = parseTimeOfDay(start);
  const endMinutes = parseTimeOfDay(end);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return false;

  const current = getZonedMinutes(now, timeZone);
  if (startMinutes < endMinutes) {
    return current >= startMinutes && current < endMinutes;
  }
  return current >= startMinutes || current < endMinutes;
}

/** 返回指定时刻之后最近一次免打扰结束时间；不在免打扰时段时返回 null。 */
export function getQuietHoursEndAt(
  now: Date,
  start: string | null | undefined,
  end: string | null | undefined,
  timeZone = SCHEDULER_TIME_ZONE,
): Date | null {
  const startMinutes = parseTimeOfDay(start);
  const endMinutes = parseTimeOfDay(end);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return null;
  if (!isWithinQuietHours(now, start, end, timeZone)) return null;

  // 调度器固定使用 Asia/Shanghai（UTC+8），将业务日期时间转换为 UTC。
  if (timeZone !== SCHEDULER_TIME_ZONE) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  const current = getZonedMinutes(now, timeZone);
  const endDayOffset = startMinutes > endMinutes && current >= startMinutes ? 1 : 0;
  return new Date(Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day) + endDayOffset,
    0,
    endMinutes - 8 * 60,
  ));
}
