import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getExportableSettingDefaults } from '@/lib/settings-catalog';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  settingUpsert: vi.fn(),
  settingFindUnique: vi.fn(),
  sourceUpdateMany: vi.fn(),
  sourceUpsert: vi.fn(),
  keywordFindMany: vi.fn(),
  keywordCreateMany: vi.fn(),
  keywordDeleteMany: vi.fn(),
  keywordCandidateDeleteMany: vi.fn(),
  keywordCandidateCreateMany: vi.fn(),
  discardedItemDeleteMany: vi.fn(),
  updateSettingsInTransaction: vi.fn(),
  replaceToolDirectorySnapshotInTransaction: vi.fn(),
  invalidateSettingsRuntimeCaches: vi.fn(),
  invalidateKeywordRuntimeCaches: vi.fn(),
  invalidatePublicTools: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: { $transaction: mocks.transaction },
}));

vi.mock('@/lib/settings-service', () => ({
  exportSettingsValues: vi.fn(),
  invalidateSettingsRuntimeCaches: mocks.invalidateSettingsRuntimeCaches,
  updateSettingsInTransaction: mocks.updateSettingsInTransaction,
}));

vi.mock('@/lib/keyword-service', () => ({
  invalidateKeywordRuntimeCaches: mocks.invalidateKeywordRuntimeCaches,
}));

vi.mock('@/lib/prompt-version-service', () => ({
  PROMPT_VERSIONS_SETTING_KEY: 'prompt_versions',
  listPromptVersions: vi.fn(),
}));

vi.mock('@/lib/settings-rebuild-service', () => ({
  SETTINGS_REBUILD_KEY: '__settings_rebuild__',
  mergeSettingsRebuildPlan: vi.fn(() => ({ publication: true, score: false })),
}));

vi.mock('@/lib/tool-directory-service', () => ({
  getToolDirectorySnapshot: vi.fn(),
  invalidatePublicTools: mocks.invalidatePublicTools,
  replaceToolDirectorySnapshotInTransaction: mocks.replaceToolDirectorySnapshotInTransaction,
}));

import { restoreProjectBackup } from '@/lib/backup-service';

const backup = {
  type: 'hot2-project-backup',
  version: 1,
  exportedAt: '2026-08-09T00:00:00.000Z',
  settings: getExportableSettingDefaults(),
  promptVersions: [],
  sources: [{
    id: 'source-1',
    name: '示例源',
    type: 'rss',
    url: 'https://example.com/feed.xml',
    parserConfig: '{}',
    enabled: true,
    publicEnabled: true,
  }],
  keywords: {
    entries: [{ category: '正面', word: '选址' }],
    candidates: [{ phrase: '商圈', occurrences: 1, sampleTitles: ['示例标题'], status: 'pending' }],
  },
  toolDirectory: {
    categories: [
      { id: 'business-support', name: '业务支持', sortOrder: 0 },
      { id: 'geo-location', name: '地理位置', sortOrder: 1 },
      { id: 'data-analysis', name: '数据分析', sortOrder: 2 },
      { id: 'network-planning', name: '点位分析', sortOrder: 3 },
      { id: 'other-tools', name: '其他工具', sortOrder: 4 },
    ],
    tools: [],
  },
};

function transactionClient() {
  return {
    setting: { upsert: mocks.settingUpsert, findUnique: mocks.settingFindUnique },
    source: { updateMany: mocks.sourceUpdateMany, upsert: mocks.sourceUpsert },
    keyword: { findMany: mocks.keywordFindMany, createMany: mocks.keywordCreateMany, deleteMany: mocks.keywordDeleteMany },
    keywordCandidate: { deleteMany: mocks.keywordCandidateDeleteMany, createMany: mocks.keywordCandidateCreateMany },
    discardedItem: { deleteMany: mocks.discardedItemDeleteMany },
  };
}

describe('完整配置恢复事务边界', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateSettingsInTransaction.mockResolvedValue({ ok: true });
    mocks.keywordFindMany.mockResolvedValue([]);
    mocks.replaceToolDirectorySnapshotInTransaction.mockResolvedValue(undefined);
    mocks.settingFindUnique.mockResolvedValue(null);
    mocks.transaction.mockImplementation(async (operation) => operation(transactionClient()));
  });

  it('将所有覆盖写入置于同一个事务，并仅在提交后失效运行时缓存', async () => {
    await expect(restoreProjectBackup(backup)).resolves.toMatchObject({ rebuildQueued: true });

    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 10_000, timeout: 30_000 });
    expect(mocks.sourceUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.sourceUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.keywordCandidateDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.replaceToolDirectorySnapshotInTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateSettingsRuntimeCaches).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateKeywordRuntimeCaches).toHaveBeenCalledTimes(1);
    expect(mocks.invalidatePublicTools).toHaveBeenCalledTimes(1);
  });

  it('事务内任一模块失败时，不刷新缓存或声明恢复成功', async () => {
    mocks.replaceToolDirectorySnapshotInTransaction.mockRejectedValue(new Error('工具目录恢复失败'));

    await expect(restoreProjectBackup(backup)).rejects.toThrow('工具目录恢复失败');

    expect(mocks.invalidateSettingsRuntimeCaches).not.toHaveBeenCalled();
    expect(mocks.invalidateKeywordRuntimeCaches).not.toHaveBeenCalled();
    expect(mocks.invalidatePublicTools).not.toHaveBeenCalled();
  });
});
