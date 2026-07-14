/**
 * 推送模式纯契约。
 *
 * 只负责合法值和字符串解析，不读取设置、不访问数据库。
 */
export const PUSH_MODES = ['off', 'batch', 'realtime'] as const;

export type PushMode = typeof PUSH_MODES[number];

export function parsePushMode(raw: string | null | undefined): PushMode {
  return raw && (PUSH_MODES as readonly string[]).includes(raw)
    ? raw as PushMode
    : 'realtime';
}
