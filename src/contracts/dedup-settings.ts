/**
 * Dedup 设置的唯一规则来源。
 *
 * 纯数据契约可被服务端运行时、设置目录和客户端设置页共同引用。
 */
export const DEDUP_SETTING_KEYS = {
  windowDays: 'dedup_window_days',
  numericSharedMin: 'dedup_numeric_shared_min',
  bodyLcsMin: 'dedup_body_lcs_min',
  lcsTotalMin: 'dedup_lcs_total_min',
  brandGateEnabled: 'dedup_brand_gate_enabled',
  shortBodyThreshold: 'dedup_short_body_threshold',
} as const;

export const DEDUP_SETTING_DEFINITIONS = {
  windowDays: { key: DEDUP_SETTING_KEYS.windowDays, defaultValue: '15', min: 1, max: 90 },
  numericSharedMin: { key: DEDUP_SETTING_KEYS.numericSharedMin, defaultValue: '2', min: 1, max: 10 },
  bodyLcsMin: { key: DEDUP_SETTING_KEYS.bodyLcsMin, defaultValue: '40', min: 20, max: 200 },
  lcsTotalMin: { key: DEDUP_SETTING_KEYS.lcsTotalMin, defaultValue: '160', min: 100, max: 1000 },
  brandGateEnabled: { key: DEDUP_SETTING_KEYS.brandGateEnabled, defaultValue: 'true' },
  shortBodyThreshold: { key: DEDUP_SETTING_KEYS.shortBodyThreshold, defaultValue: '1000', min: 500, max: 5000 },
} as const;

export type DedupSettingName = keyof typeof DEDUP_SETTING_DEFINITIONS;
