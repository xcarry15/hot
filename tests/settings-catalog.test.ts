import { describe, expect, it } from 'vitest';
import {
  EXPORTABLE_SETTING_KEYS,
  FRONTEND_SETTING_KEYS,
  SETTING_DEFINITIONS,
  SENSITIVE_SETTING_KEYS,
  getFrontendSettingDefaults,
  getSettingDefaults,
} from '@/lib/settings-catalog';
import { DEDUP_SETTING_DEFINITIONS } from '@/contracts/dedup-settings';

describe('settings catalog', () => {
  it('由描述表派生导出、前端和敏感 key 清单', () => {
    const definitions = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

    expect(new Set(EXPORTABLE_SETTING_KEYS)).toEqual(new Set(
      SETTING_DEFINITIONS.filter((definition) => definition.exportable).map((definition) => definition.key),
    ));
    expect(new Set(FRONTEND_SETTING_KEYS)).toEqual(new Set(
      SETTING_DEFINITIONS.filter((definition) => definition.frontend).map((definition) => definition.key),
    ));
    for (const key of SENSITIVE_SETTING_KEYS) {
      expect(definitions.get(key)?.sensitive).toBe(true);
    }
  });

  it('每个可写 key 都有校验，未声明的运行态 key 不可导出', () => {
    for (const definition of SETTING_DEFINITIONS.filter((item) => item.exportable)) {
      expect(definition.schema).toBeDefined();
    }
    expect(EXPORTABLE_SETTING_KEYS).not.toContain('scheduler_last_crawl_at');
    expect(EXPORTABLE_SETTING_KEYS).not.toContain('scheduler_last_push_date');
  });

  it('默认值和前端“使用默认提示词”空值均从目录派生', () => {
    const runtimeDefaults = getSettingDefaults();
    const frontendDefaults = getFrontendSettingDefaults();

    expect(runtimeDefaults.push_mode).toBe('realtime');
    expect(runtimeDefaults.ai_block_ad).toContain('is_ad');
    expect(frontendDefaults.ai_block_ad).toBe('');
    expect(frontendDefaults.crawl_interval_min).toBe('120');
  });

  it('Dedup 目录的 key、默认值和边界来自纯契约', () => {
    for (const definition of Object.values(DEDUP_SETTING_DEFINITIONS)) {
      const catalogDefinition = SETTING_DEFINITIONS.find((item) => item.key === definition.key);
      expect(catalogDefinition?.defaultValue).toBe(definition.defaultValue);
      if ('min' in definition && 'max' in definition) {
        expect(definition.min).toBeLessThanOrEqual(definition.max);
      }
    }
  });
});
