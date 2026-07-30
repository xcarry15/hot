import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROMPT_SETTINGS } from '@/lib/prompts';

const mocks = vi.hoisted(() => ({
  settingFindUnique: vi.fn(),
  settingUpsert: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    setting: {
      findUnique: mocks.settingFindUnique,
      upsert: mocks.settingUpsert,
    },
  },
}));

import { createPromptVersion, deletePromptVersion, listPromptVersions } from '@/lib/prompt-version-service';

const prompts = { ...DEFAULT_PROMPT_SETTINGS };

describe('提示词版本服务', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingFindUnique.mockResolvedValue(null);
    mocks.settingUpsert.mockResolvedValue({});
  });

  it('保存当前完整提示词快照，并将新版本放在最前面', async () => {
    const version = await createPromptVersion({ name: '低噪声评分 v1', prompts });

    expect(version.name).toBe('低噪声评分 v1');
    expect(version.prompts).toEqual(prompts);
    expect(mocks.settingUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'prompt_versions_v1' },
      create: expect.objectContaining({
        key: 'prompt_versions_v1',
        value: JSON.stringify([version]),
      }),
    }));
  });

  it('损坏或不完整的历史快照不会阻断版本列表', async () => {
    mocks.settingFindUnique.mockResolvedValue({ value: JSON.stringify([
      { id: 'broken', name: '损坏版本', createdAt: new Date().toISOString(), prompts: { ai_system_prompt: 'only one' } },
    ]) });

    await expect(listPromptVersions()).resolves.toEqual([]);
  });

  it('删除存在的版本，未知版本不写入存储', async () => {
    const stored = {
      id: 'v1',
      name: '旧版',
      createdAt: '2026-07-30T00:00:00.000Z',
      prompts,
    };
    mocks.settingFindUnique.mockResolvedValue({ value: JSON.stringify([stored]) });

    await expect(deletePromptVersion('v1')).resolves.toBe(true);
    expect(mocks.settingUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { value: '[]' },
    }));

    mocks.settingFindUnique.mockResolvedValue({ value: '[]' });
    await expect(deletePromptVersion('missing')).resolves.toBe(false);
    expect(mocks.settingUpsert).toHaveBeenCalledTimes(1);
  });
});
