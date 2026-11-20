import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY_A = 'rotate-security-test-key-A';
const KEY_B = 'rotate-security-test-key-B';
const LEGACY_WEBHOOK_FIXTURE = '[{"url":"enc:v1:6:-token:67741602eef467fd332e0241:53037b1c78c5134ac262f7937d4d5b9c:87e5e67e6aac90f8ad07a290df5458a5cf35a8d73c593b8d650d5bda43f19190e49a3dfc1f8922dfa643c1a5865073927ccc42ac679d0b78931e","remark":"","enabled":true}]';
const FIXTURE_KEY = 'test-fixture-secret-key-for-encryption';

describe('P0-3 安全专项：envelope / AAD / 密钥轮换 / 启动自检', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SETTINGS_ENCRYPTION_KEY', KEY_A);
    vi.stubEnv('SETTINGS_ENCRYPTION_KEY_PREVIOUS', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('兼容历史 enc:v1 值（无 keyId / 无 AAD）解密', async () => {
    vi.stubEnv('SETTINGS_ENCRYPTION_KEY', FIXTURE_KEY);
    const m = await import('@/lib/settings-crypto');
    const configs = JSON.parse(m.decryptWebhookConfigsForRuntime(LEGACY_WEBHOOK_FIXTURE));
    expect(configs[0].url.startsWith('https://open.feishu.cn/')).toBe(true);
  });

  it('新 envelope 含 keyId 且仍保持 enc:v1 前缀', async () => {
    const m = await import('@/lib/settings-crypto');
    const encrypted = m.encryptSensitiveSetting('proxy-secret');
    expect(encrypted).toMatch(/^enc:v1:k[0-9a-f]{12}:/);
    expect(encrypted).not.toContain('proxy-secret');
    expect(m.decryptSensitiveSetting(encrypted)).toBe('proxy-secret');
  });

  it('AAD 绑定 setting key：密文不能跨字段搬移', async () => {
    const m = await import('@/lib/settings-crypto');
    const stolen = m.encryptSensitiveSetting('field-A-secret', 'field_a');
    expect(m.decryptSensitiveSetting(stolen, 'field_a')).toBe('field-A-secret');
    expect(() => m.decryptSensitiveSetting(stolen, 'field_b')).toThrow();
  });

  it('畸形 envelope 显式抛错，不再静默当明文', async () => {
    const m = await import('@/lib/settings-crypto');
    expect(() => m.decryptSensitiveSetting('enc:v1:deadbeef')).toThrow(/格式无效/);
    expect(() => m.decryptSensitiveSetting('enc:v1:kabcdef123456:zz:aa:bb')).toThrow(/格式无效/);
    expect(() => m.decryptWebhookConfigsForRuntime('[{"url":"enc:v1:x:y","remark":"","enabled":true}]')).toThrow();
  });

  it('keyId 可选旧密钥：轮换后残留旧密文仍可解，未配置旧密钥则明确失败', async () => {
    const m = await import('@/lib/settings-crypto');
    const oldCipher = m.encryptSensitiveSetting('straggler-secret');

    vi.stubEnv('SETTINGS_ENCRYPTION_KEY', KEY_B);
    expect(() => m.decryptSensitiveSetting(oldCipher)).toThrow(/SETTINGS_ENCRYPTION_KEY/);

    vi.stubEnv('SETTINGS_ENCRYPTION_KEY_PREVIOUS', KEY_A);
    expect(m.decryptSensitiveSetting(oldCipher)).toBe('straggler-secret');
  });

  it('轮换把全部 enc:v1（文本 + webhook）迁移到新密钥', async () => {
    const m = await import('@/lib/settings-crypto');
    const plainKey = 'sk-rotate-me';
    const webhook = JSON.stringify([
      { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/rotate123456', remark: '', enabled: true },
    ]);
    const textCipher = m.encryptSensitiveSetting(plainKey);
    const webhookCipher = m.encryptWebhookConfigsForStorage(webhook);
    expect(m.containsEncryptedSettingValue(textCipher)).toBe(true);
    expect(m.containsEncryptedSettingValue(webhookCipher)).toBe(true);

    const rotatedText = m.reencryptSettingValueForRotation(textCipher, KEY_A, KEY_B, 'text');
    const rotatedWebhook = m.reencryptSettingValueForRotation(webhookCipher, KEY_A, KEY_B, 'webhook');
    expect(rotatedText).toMatch(/^enc:v1:k[0-9a-f]{12}:/);

    vi.stubEnv('SETTINGS_ENCRYPTION_KEY', KEY_B);
    expect(m.canDecryptWithSecret(rotatedText, KEY_B, 'text')).toBe(true);
    expect(m.canDecryptWithSecret(rotatedWebhook, KEY_B, 'webhook')).toBe(true);
    expect(m.decryptSensitiveSetting(rotatedText)).toBe(plainKey);
    expect(m.decryptWebhookConfigsForRuntime(rotatedWebhook)).toBe(webhook);

    // 旧密钥无法解密新密文，证明确实完成了迁移。
    expect(m.canDecryptWithSecret(rotatedText, KEY_A, 'text')).toBe(false);
  });

  describe('assertSettingsCryptoHealthy', () => {
    let findMany: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const db = (await import('@/lib/db')).db;
      findMany = vi.mocked(db.setting.findMany) as unknown as ReturnType<typeof vi.fn>;
      findMany.mockReset();
    });

    it('全部 enc:v1 可解密时通过，跳过脱敏占位值', async () => {
      const m = await import('@/lib/settings-crypto');
      const svc = await import('@/lib/settings-service');
      const webhook = JSON.stringify([
        { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/health123456', remark: '', enabled: true },
      ]);
      findMany.mockResolvedValue([
        { key: 'deepseek_api_key', value: m.encryptSensitiveSetting('sk-healthy') },
        { key: 'feishu_webhook_url', value: m.encryptWebhookConfigsForStorage(webhook) },
        { key: 'gemini_api_key', value: '' },
        { key: 'outbound_proxy_url', value: '[]' },
      ]);
      await expect(svc.assertSettingsCryptoHealthy()).resolves.toBeUndefined();
    });

    it('密钥错误时抛错，且错误不泄漏明文或密钥', async () => {
      const m = await import('@/lib/settings-crypto');
      const svc = await import('@/lib/settings-service');
      const cipher = m.encryptSensitiveSetting('super-secret-key-material');
      vi.stubEnv('SETTINGS_ENCRYPTION_KEY', 'totally-wrong-key');

      findMany.mockResolvedValue([{ key: 'deepseek_api_key', value: cipher }]);
      await expect(svc.assertSettingsCryptoHealthy()).rejects.toThrow(/deepseek_api_key/);

      // 抓取实际错误消息，确认没有明文或密钥泄漏。
      const error = await svc.assertSettingsCryptoHealthy().catch((e: unknown) => e) as Error;
      expect(error.message).not.toContain('super-secret-key-material');
      expect(error.message).not.toContain('totally-wrong-key');
    });
  });
});
