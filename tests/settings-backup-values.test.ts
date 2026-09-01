import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ settingFindMany: vi.fn() }));

vi.mock('@/lib/db', () => ({
  db: { setting: { findMany: mocks.settingFindMany } },
}));

import { EXPORTABLE_SETTING_KEYS } from '@/lib/settings';
import { exportSettingsValues } from '@/lib/settings-service';
import { encryptSensitiveSetting, encryptWebhookConfigsForStorage } from '@/lib/settings-crypto';

describe('settings backup values', () => {
  beforeEach(() => vi.clearAllMocks());

  it('导出完整可编辑配置并解密 Webhook', async () => {
    const webhook = JSON.stringify([
      { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/export123456', remark: '主群', enabled: true },
    ]);
    mocks.settingFindMany.mockResolvedValue([
      { key: 'ai_provider', value: 'deepseek' },
      { key: 'deepseek_api_key', value: encryptSensitiveSetting('sk-export-secret') },
      { key: 'feishu_webhook_url', value: encryptWebhookConfigsForStorage(webhook) },
    ]);

    const settings = await exportSettingsValues();

    expect(settings.deepseek_api_key).toBe('sk-export-secret');
    expect(settings.feishu_webhook_url).toBe(webhook);
    expect(settings.ai_provider).toBe('deepseek');
  });

  it('只查询可备份设置键并排除运行态键', async () => {
    mocks.settingFindMany.mockResolvedValue([{ key: 'ai_provider', value: 'opencode' }]);

    const settings = await exportSettingsValues();
    expect(settings.ai_provider).toBe('opencode');
    expect('scheduler_last_crawl_at' in settings).toBe(false);

    const arg = mocks.settingFindMany.mock.calls[0][0];
    expect(arg.where.key.in).toEqual(Array.from(EXPORTABLE_SETTING_KEYS));
    expect(arg.where.key.in).not.toContain('scheduler_last_crawl_at');
  });
});
