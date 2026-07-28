import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decryptWebhookConfigsForRuntime,
  encryptWebhookConfigsForStorage,
} from '@/lib/settings-crypto';

afterEach(() => vi.unstubAllEnvs());

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

  it('加密根只依赖 SETTINGS_ENCRYPTION_KEY，不受 API_TOKEN 轮换影响', () => {
    const source = JSON.stringify([
      { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/stable123456', remark: '', enabled: true },
    ]);
    vi.stubEnv('SETTINGS_ENCRYPTION_KEY', 'stable-settings-key');
    vi.stubEnv('API_TOKEN', 'old-login-token');
    const encrypted = encryptWebhookConfigsForStorage(source);

    vi.stubEnv('API_TOKEN', 'rotated-login-token');
    expect(decryptWebhookConfigsForRuntime(encrypted)).toBe(source);
  });

  it('生产环境缺少独立加密密钥时拒绝读写敏感配置', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SETTINGS_ENCRYPTION_KEY', '');
    vi.stubEnv('API_TOKEN', 'login-token-must-not-be-used');

    expect(() => encryptWebhookConfigsForStorage(JSON.stringify([
      { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/strict123456', remark: '', enabled: true },
    ]))).toThrow('SETTINGS_ENCRYPTION_KEY');
  });
});
