import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExportableSettingDefaults } from '@/lib/settings-catalog';

const mocks = vi.hoisted(() => ({
  sourceFindMany: vi.fn(),
  keywordFindMany: vi.fn(),
  candidateFindMany: vi.fn(),
  transaction: vi.fn(),
  exportSettingsValues: vi.fn(),
  listPromptVersions: vi.fn(),
  getToolDirectorySnapshot: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    source: { findMany: mocks.sourceFindMany },
    keyword: { findMany: mocks.keywordFindMany },
    keywordCandidate: { findMany: mocks.candidateFindMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/settings-service', () => ({
  exportSettingsValues: mocks.exportSettingsValues,
  invalidateSettingsRuntimeCaches: vi.fn(),
  updateSettingsInTransaction: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/prompt-version-service', () => ({
  PROMPT_VERSIONS_SETTING_KEY: 'prompt_versions',
  listPromptVersions: mocks.listPromptVersions,
}));
vi.mock('@/lib/tool-directory-service', () => ({
  getToolDirectorySnapshot: mocks.getToolDirectorySnapshot,
  invalidatePublicTools: vi.fn(),
  replaceToolDirectorySnapshotInTransaction: vi.fn(),
}));
vi.mock('@/lib/keyword-service', () => ({ invalidateKeywordRuntimeCaches: vi.fn() }));
vi.mock('@/lib/settings-rebuild-service', () => ({
  SETTINGS_REBUILD_KEY: '__settings_rebuild__',
  mergeSettingsRebuildPlan: vi.fn(() => ({ score: false, publication: true })),
}));

import { exportProjectBackup, restoreProjectBackup } from '@/lib/backup-service';

describe('P1 安全专项：完整备份 HMAC 签名', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('BACKUP_SIGNING_KEY', 'backup-signature-test-key');
    vi.stubEnv('SETTINGS_ENCRYPTION_KEY', 'settings-key-test');
    mocks.exportSettingsValues.mockResolvedValue(getExportableSettingDefaults());
    mocks.listPromptVersions.mockResolvedValue([]);
    mocks.sourceFindMany.mockResolvedValue([]);
    mocks.keywordFindMany.mockResolvedValue([]);
    mocks.candidateFindMany.mockResolvedValue([]);
    mocks.getToolDirectorySnapshot.mockResolvedValue({
      categories: [{ id: 'business-support', name: '业务支持', sortOrder: 0 }],
      tools: [],
    });
    mocks.transaction.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  async function signedBackup(): Promise<Record<string, unknown>> {
    return await exportProjectBackup() as unknown as Record<string, unknown>;
  }

  it('导出的备份带 64 位十六进制 HMAC 签名', async () => {
    const backup = await signedBackup();
    expect(backup.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(backup)).not.toContain('backup-signature-test-key');
  });

  it('签名备份可正常恢复', async () => {
    const backup = await signedBackup();
    await expect(restoreProjectBackup(backup)).resolves.toMatchObject({ rebuildQueued: true });
  });

  it('篡改载荷后签名校验失败', async () => {
    const backup = await signedBackup();
    const tampered = { ...backup, settings: { ...(backup.settings as object), ai_provider: 'tampered' } };
    await expect(restoreProjectBackup(tampered)).rejects.toThrow(/签名校验失败/);
  });

  it('旧的无签名备份 warn 兼容', async () => {
    const backup = await signedBackup();
    const { signature, ...legacy } = backup;
    expect(typeof signature).toBe('string');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(restoreProjectBackup(legacy)).resolves.toMatchObject({ rebuildQueued: true });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('缺少 HMAC 签名'));
    } finally {
      warn.mockRestore();
    }
  });

  it('错误签名密钥被拒绝；旧密钥列在 PREVIOUS 时可继续恢复', async () => {
    const backup = await signedBackup();
    vi.stubEnv('BACKUP_SIGNING_KEY', 'a-different-signing-key');
    await expect(restoreProjectBackup(backup)).rejects.toThrow(/签名校验失败/);

    vi.stubEnv('SETTINGS_ENCRYPTION_KEY_PREVIOUS', 'backup-signature-test-key');
    await expect(restoreProjectBackup(backup)).resolves.toMatchObject({ rebuildQueued: true });
  });
});
