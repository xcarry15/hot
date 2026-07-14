import { getSetting, SETTING_KEYS } from './settings';
import { DEDUP_SETTING_DEFINITIONS } from '@/contracts/dedup-settings';

export interface DedupConfig {
  windowDays: number;
  numericSharedMin: number;
  bodyLcsMin: number;
  lcsTotalMin: number;
  brandGateEnabled: boolean;
  shortBodyThreshold: number;
}

export const DEDUP_LIMITS = {
  windowDays: { min: DEDUP_SETTING_DEFINITIONS.windowDays.min, max: DEDUP_SETTING_DEFINITIONS.windowDays.max, default: Number(DEDUP_SETTING_DEFINITIONS.windowDays.defaultValue) },
  numericSharedMin: { min: DEDUP_SETTING_DEFINITIONS.numericSharedMin.min, max: DEDUP_SETTING_DEFINITIONS.numericSharedMin.max, default: Number(DEDUP_SETTING_DEFINITIONS.numericSharedMin.defaultValue) },
  bodyLcsMin: { min: DEDUP_SETTING_DEFINITIONS.bodyLcsMin.min, max: DEDUP_SETTING_DEFINITIONS.bodyLcsMin.max, default: Number(DEDUP_SETTING_DEFINITIONS.bodyLcsMin.defaultValue) },
  lcsTotalMin: { min: DEDUP_SETTING_DEFINITIONS.lcsTotalMin.min, max: DEDUP_SETTING_DEFINITIONS.lcsTotalMin.max, default: Number(DEDUP_SETTING_DEFINITIONS.lcsTotalMin.defaultValue) },
  brandGateEnabled: { default: DEDUP_SETTING_DEFINITIONS.brandGateEnabled.defaultValue === 'true' },
  shortBodyThreshold: { min: DEDUP_SETTING_DEFINITIONS.shortBodyThreshold.min, max: DEDUP_SETTING_DEFINITIONS.shortBodyThreshold.max, default: Number(DEDUP_SETTING_DEFINITIONS.shortBodyThreshold.defaultValue) },
} as const;

const CONFIG_CACHE_TTL_MS = 30_000;

interface CachedConfig {
  config: DedupConfig;
  cachedAt: number;
}

let baseCache: CachedConfig | null = null;

function clampNumber(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export async function getDedupConfig(_sourceId?: string): Promise<DedupConfig> {
  const now = Date.now();

  if (!baseCache || now - baseCache.cachedAt > CONFIG_CACHE_TTL_MS) {
    const [
      windowDaysRaw,
      numericRaw,
      bodyLcsRaw,
      lcsTotalRaw,
      brandGateRaw,
      shortBodyRaw,
    ] = await Promise.all([
      getSetting(SETTING_KEYS.DEDUP_WINDOW_DAYS),
      getSetting(SETTING_KEYS.DEDUP_NUMERIC_SHARED_MIN),
      getSetting(SETTING_KEYS.DEDUP_BODY_LCS_MIN),
      getSetting(SETTING_KEYS.DEDUP_LCS_TOTAL_MIN),
      getSetting(SETTING_KEYS.DEDUP_BRAND_GATE_ENABLED),
      getSetting(SETTING_KEYS.DEDUP_SHORT_BODY_THRESHOLD),
    ]);

    baseCache = {
      config: {
        windowDays: clampNumber(windowDaysRaw, DEDUP_LIMITS.windowDays.min, DEDUP_LIMITS.windowDays.max, DEDUP_LIMITS.windowDays.default),
        numericSharedMin: clampNumber(numericRaw, DEDUP_LIMITS.numericSharedMin.min, DEDUP_LIMITS.numericSharedMin.max, DEDUP_LIMITS.numericSharedMin.default),
        bodyLcsMin: clampNumber(bodyLcsRaw, DEDUP_LIMITS.bodyLcsMin.min, DEDUP_LIMITS.bodyLcsMin.max, DEDUP_LIMITS.bodyLcsMin.default),
        lcsTotalMin: clampNumber(lcsTotalRaw, DEDUP_LIMITS.lcsTotalMin.min, DEDUP_LIMITS.lcsTotalMin.max, DEDUP_LIMITS.lcsTotalMin.default),
        brandGateEnabled: parseBool(brandGateRaw, DEDUP_LIMITS.brandGateEnabled.default),
        shortBodyThreshold: clampNumber(shortBodyRaw, DEDUP_LIMITS.shortBodyThreshold.min, DEDUP_LIMITS.shortBodyThreshold.max, DEDUP_LIMITS.shortBodyThreshold.default),
      },
      cachedAt: now,
    };
  }
  return baseCache.config;
}

export function _invalidateDedupConfig(): void {
  baseCache = null;
}
