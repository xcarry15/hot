import { describe, expect, it } from 'vitest';
import {
  decryptWebhookConfigsForRuntime,
  encryptWebhookConfigsForStorage,
} from '@/lib/settings-crypto';

describe('Webhook 配置加密', () => {
  it('加密 URL，保留末 6 位标识，并可恢复完整配置', () => {
    const source = JSON.stringify([
      {
        url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef123456',
        remark: '主群',
        enabled: true,
      },
    ]);

    const encrypted = encryptWebhookConfigsForStorage(source);
    expect(encrypted).toMatch(/^\[{"url":"enc:v1:6:123456:/);
    expect(encrypted).not.toContain('abcdef123456');
    expect(decryptWebhookConfigsForRuntime(encrypted)).toBe(source);
  });

  it('兼容历史明文，并在再次保存时转为加密格式', () => {
    const legacy = JSON.stringify([
      { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/legacy123456', remark: '', enabled: true },
    ]);

    expect(decryptWebhookConfigsForRuntime(legacy)).toBe(legacy);
    expect(encryptWebhookConfigsForStorage(legacy)).toMatch(/^\[{"url":"enc:v1:6:123456:/);
  });
});
