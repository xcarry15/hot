import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    setting: {
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
    },
  },
}));

import { getSetting, readAllSettings } from '@/lib/settings';
import { encryptSensitiveSetting } from '@/lib/settings-crypto';

describe('AI Provider API Key 运行时读取', () => {
  beforeEach(() => vi.clearAllMocks());

  it('单项和批量读取都返回解密后的 Key，并兼容历史明文', async () => {
    const encrypted = encryptSensitiveSetting('sk-encrypted');
    mocks.findUnique.mockResolvedValue({ value: encrypted });
    mocks.findMany.mockResolvedValue([
      { key: 'opencode_api_key', value: encrypted },
      { key: 'deepseek_api_key', value: 'sk-legacy-plaintext' },
    ]);

    await expect(getSetting('opencode_api_key')).resolves.toBe('sk-encrypted');
    await expect(readAllSettings()).resolves.toMatchObject({
      opencode_api_key: 'sk-encrypted',
      deepseek_api_key: 'sk-legacy-plaintext',
    });
  });
});
