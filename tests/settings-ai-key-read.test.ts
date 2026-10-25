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

import { getSetting, readAllSettings, readSettings } from '@/lib/settings';
import { encryptSensitiveSetting } from '@/lib/settings-crypto';

describe('AI Provider API Key 运行时读取', () => {
  beforeEach(() => vi.clearAllMocks());

  it('单项和批量读取都返回解密后的 Key，并兼容历史明文', async () => {
    const encrypted = encryptSensitiveSetting('sk-encrypted');
    mocks.findUnique.mockResolvedValue({ value: encrypted });
    mocks.findMany.mockResolvedValue([
      { key: 'deepseek_api_key', value: encrypted },
      { key: 'gemini_api_key', value: 'sk-legacy-plaintext' },
    ]);

    await expect(getSetting('deepseek_api_key')).resolves.toBe('sk-encrypted');
    await expect(readAllSettings()).resolves.toMatchObject({
      deepseek_api_key: 'sk-encrypted',
      gemini_api_key: 'sk-legacy-plaintext',
    });
  });

  it('按需读取设置时只查询并解密请求的 key', async () => {
    const encrypted = encryptSensitiveSetting('sk-current');
    mocks.findMany.mockResolvedValue([
      { key: 'deepseek_api_key', value: encrypted },
      { key: 'gemini_api_key', value: 'sk-unrelated' },
    ]);

    await expect(readSettings(['deepseek_api_key'])).resolves.toEqual({
      deepseek_api_key: 'sk-current',
    });
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { key: { in: ['deepseek_api_key'] } },
    });
  });
});
