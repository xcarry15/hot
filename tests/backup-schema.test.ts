import { describe, expect, it } from 'vitest';
import { projectBackupSchema } from '@/lib/backup-schema';
import { getExportableSettingDefaults } from '@/lib/settings-catalog';

const validBackup = {
  type: 'hot2-project-backup',
  version: 1,
  exportedAt: '2026-08-09T00:00:00.000Z',
  settings: getExportableSettingDefaults(),
  promptVersions: [],
  sources: [],
  keywords: { entries: [], candidates: [] },
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

describe('project backup schema', () => {
  it('接受当前完整备份格式', () => {
    expect(projectBackupSchema.safeParse(validBackup).success).toBe(true);
  });

  it('拒绝旧类型、旧版本和缺失模块', () => {
    expect(projectBackupSchema.safeParse({ ...validBackup, type: 'hot2-settings' }).success).toBe(false);
    expect(projectBackupSchema.safeParse({ ...validBackup, version: 2 }).success).toBe(false);
    const { keywords: _keywords, ...missingKeywords } = validBackup;
    void _keywords;
    expect(projectBackupSchema.safeParse(missingKeywords).success).toBe(false);
  });

  it('拒绝缺少设置项或包含未知设置项的伪完整备份', () => {
    expect(projectBackupSchema.safeParse({ ...validBackup, settings: { ai_provider: 'opencode' } }).success).toBe(false);
    expect(projectBackupSchema.safeParse({
      ...validBackup,
      settings: { ...validBackup.settings, obsolete_setting: '1' },
    }).success).toBe(false);
  });

  it('拒绝重复数据源和关键词', () => {
    const source = {
      id: 'source-1',
      name: '示例源',
      type: 'rss',
      url: 'https://example.com/feed.xml',
      parserConfig: '{}',
      enabled: true,
      publicEnabled: true,
    };
    expect(projectBackupSchema.safeParse({ ...validBackup, sources: [source, source] }).success).toBe(false);
    expect(projectBackupSchema.safeParse({
      ...validBackup,
      keywords: {
        entries: [{ category: '正面', word: '选址' }, { category: '正面', word: '选址' }],
        candidates: [],
      },
    }).success).toBe(false);
  });

  it('接受带动态分类 ID 与可选 hidden 字段的工具目录备份', () => {
    expect(projectBackupSchema.safeParse({
      ...validBackup,
      toolDirectory: {
        categories: [
          { id: 'business-support', name: '业务支持', sortOrder: 0 },
          { id: 'custom-tools', name: '自定义分类', sortOrder: 1, hidden: true },
        ],
        tools: [{
          id: 'tool-1',
          name: '示例工具',
          description: '用于验证工具目录输入的示例工具。',
          category: 'custom-tools',
          href: 'https://example.com/tool',
          icon: 'store',
          status: 'active',
          tags: ['updated'],
          sortOrder: 0,
          archivedAt: null,
        }],
      },
    }).success).toBe(true);
  });

  it('拒绝引用了备份中不存在分类的工具备份', () => {
    expect(projectBackupSchema.safeParse({
      ...validBackup,
      toolDirectory: {
        categories: validBackup.toolDirectory.categories,
        tools: [{
          id: 'tool-1',
          name: '示例工具',
          description: '用于验证工具目录输入的示例工具。',
          category: 'missing-category',
          href: 'https://example.com/tool',
          icon: 'store',
          status: 'active',
          tags: ['updated'],
          sortOrder: 0,
          archivedAt: null,
        }],
      },
    }).success).toBe(false);
  });
});
