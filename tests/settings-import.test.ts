/**
 * parseSettingsImport 导入文件解析/校验测试
 */
import { describe, it, expect } from 'vitest';
import { parseSettingsImport } from '@/lib/settings-import';

const valid = JSON.stringify({
  type: 'hot2-settings',
  version: 1,
  exportedAt: '2026-07-07T00:00:00.000Z',
  settings: { ai_provider: 'deepseek', push_min_score: '60' },
});

describe('parseSettingsImport', () => {
  it('合法文件：返回 ok + settings', () => {
    const r = parseSettingsImport(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.settings).toEqual({ ai_provider: 'deepseek', push_min_score: '60' });
  });

  it('非法 JSON：ok=false', () => {
    const r = parseSettingsImport('{ not json');
    expect(r.ok).toBe(false);
  });

  it('type 不符：ok=false', () => {
    const r = parseSettingsImport(JSON.stringify({ type: 'other', version: 1, settings: {} }));
    expect(r.ok).toBe(false);
  });

  it('version 不符：ok=false', () => {
    const r = parseSettingsImport(JSON.stringify({ type: 'hot2-settings', version: 2, settings: {} }));
    expect(r.ok).toBe(false);
  });

  it('丢弃未知键与非字符串值', () => {
    const raw = JSON.stringify({
      type: 'hot2-settings', version: 1,
      settings: { ai_provider: 'deepseek', bogus_key: 'x', push_min_score: 60 },
    });
    const r = parseSettingsImport(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings).toEqual({ ai_provider: 'deepseek' }); // bogus_key 丢弃; push_min_score 非字符串丢弃
    }
  });

  it('settings 缺失或非对象：ok=false', () => {
    expect(parseSettingsImport(JSON.stringify({ type: 'hot2-settings', version: 1 })).ok).toBe(false);
  });
});
