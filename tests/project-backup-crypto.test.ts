import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { ProjectBackupPayload } from '@/contracts/backup';
import {
  decryptProjectBackup,
  encryptProjectBackup,
  isEncryptedProjectBackup,
} from '@/features/project-backup-crypto.client';

const payload: ProjectBackupPayload = {
  type: 'hot2-project-backup',
  version: 1,
  exportedAt: '2026-08-09T00:00:00.000Z',
  settings: {
    deepseek_api_key: 'sk-sensitive-key',
    feishu_webhook_url: '[{"url":"https://open.feishu.cn/hook/sensitive-webhook"}]',
  },
  promptVersions: [],
  sources: [],
  keywords: { entries: [], candidates: [] },
  toolDirectory: { categories: [], tools: [] },
};

beforeAll(() => {
  if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
});

describe('完整配置备份加密封装', () => {
  it('加密文件不含敏感配置明文，且可使用正确密码恢复', async () => {
    const encrypted = await encryptProjectBackup(payload, 'a-strong-backup-password');
    const serialized = JSON.stringify(encrypted);

    expect(isEncryptedProjectBackup(encrypted)).toBe(true);
    expect(serialized).not.toContain('sk-sensitive-key');
    expect(serialized).not.toContain('sensitive-webhook');
    await expect(decryptProjectBackup(encrypted, 'a-strong-backup-password')).resolves.toEqual(payload);
  }, 30_000);

  it('拒绝错误密码、篡改密文与旧的明文载荷', async () => {
    const encrypted = await encryptProjectBackup(payload, 'a-strong-backup-password');
    const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}aa` };

    await expect(decryptProjectBackup(encrypted, 'another-strong-password')).rejects.toThrow('备份密码错误或文件已损坏');
    await expect(decryptProjectBackup(tampered, 'a-strong-backup-password')).rejects.toThrow('备份密码错误或文件已损坏');
    await expect(decryptProjectBackup(payload, 'a-strong-backup-password')).rejects.toThrow('不是当前项目的加密备份文件');
  }, 30_000);
});
