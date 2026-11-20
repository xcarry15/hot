import { afterEach, describe, expect, it } from 'vitest';

const FIXTURE_KEY = 'test-fixture-secret-key-for-encryption';
const WEBHOOK_FIXTURE = '[{"url":"enc:v1:6:-token:67741602eef467fd332e0241:53037b1c78c5134ac262f7937d4d5b9c:87e5e67e6aac90f8ad07a290df5458a5cf35a8d73c593b8d650d5bda43f19190e49a3dfc1f8922dfa643c1a5865073927ccc42ac679d0b78931e","remark":"","enabled":true}]';

describe('settings crypto: key rotation must re-encrypt ALL enc:v1 values', () => {
  const prev = process.env.SETTINGS_ENCRYPTION_KEY;
  afterEach(() => { if (prev === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY; else process.env.SETTINGS_ENCRYPTION_KEY = prev; });

  it('正确密钥可解密真实密文夹具', async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = FIXTURE_KEY;
    const m = await import('@/lib/settings-crypto');
    const configs = JSON.parse(m.decryptWebhookConfigsForRuntime(WEBHOOK_FIXTURE));
    expect(configs).toHaveLength(1);
    expect(configs[0].url.startsWith('https://open.feishu.cn/')).toBe(true);
    expect(configs[0].url.includes('enc:v1')).toBe(false);
  });

  it('密钥变更后未重加密的密文解密失败（证明轮换必须迁移全部 enc:v1）', async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = 'a-different-key';
    const m = await import('@/lib/settings-crypto');
    expect(() => m.decryptWebhookConfigsForRuntime(WEBHOOK_FIXTURE)).toThrow(/解密失败/);
  });

  it('重加密后新密钥可解密（迁移流程正确性）', async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = FIXTURE_KEY;
    const m = await import('@/lib/settings-crypto');
    const plain = m.decryptWebhookConfigsForRuntime(WEBHOOK_FIXTURE);
    process.env.SETTINGS_ENCRYPTION_KEY = 'new-key-after-rotation';
    const reEncrypted = m.encryptWebhookConfigsForStorage(plain);
    expect(reEncrypted.includes('enc:v1')).toBe(true);
    const configs = JSON.parse(m.decryptWebhookConfigsForRuntime(reEncrypted));
    expect(configs[0].url.startsWith('https://')).toBe(true);
  });
});
