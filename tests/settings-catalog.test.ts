import { describe, expect, it } from 'vitest';
import {
  EXPORTABLE_SETTING_KEYS,
  FRONTEND_SETTING_KEYS,
  SETTING_DEFINITIONS,
  SENSITIVE_SETTING_KEYS,
  WRITABLE_SETTING_KEYS,
  getFrontendSettingDefaults,
  getSettingDefaults,
} from '@/lib/settings-catalog';

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

  it('可写 key 的默认值均通过对应校验，运行态 key 不可写入或导出', () => {
    const definitions = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));
    for (const key of WRITABLE_SETTING_KEYS) {
      const definition = definitions.get(key);
      expect(definition).toBeDefined();
      expect(definition!.schema.safeParse(definition!.defaultValue).success).toBe(true);
    }
    for (const key of ['scheduler_last_crawl_at', 'scheduler_last_push_date', 'scheduler_push_job']) {
      expect(WRITABLE_SETTING_KEYS).not.toContain(key);
      expect(EXPORTABLE_SETTING_KEYS).not.toContain(key);
    }
  });

  it('默认值和前端“使用默认提示词”空值均从目录派生', () => {
    const runtimeDefaults = getSettingDefaults();
    const frontendDefaults = getFrontendSettingDefaults();

    expect(runtimeDefaults.push_mode).toBe('realtime');
    expect(runtimeDefaults.ai_keyword_match_bonus).toBe('5');
    expect(runtimeDefaults.ai_max_tokens).toBe('8192');
    expect(runtimeDefaults.ai_block_ad).toContain('is_ad');
    expect(frontendDefaults.ai_block_ad).toBe('');
    expect(frontendDefaults.crawl_interval_min).toBe('120');
  });

  it('旧文章去重阈值不再暴露为设置', () => {
    expect(SETTING_DEFINITIONS.some((item) => item.key.startsWith('dedup_'))).toBe(false);
  });

  it('聚类不再暴露二次 AI 阈值', () => {
    expect(SETTING_DEFINITIONS.some((item) => item.key.startsWith('event_cluster_ai_'))).toBe(false);
  });
});
