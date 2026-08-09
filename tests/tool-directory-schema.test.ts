import { describe, expect, it } from 'vitest';
import { toolCreateSchema, toolDirectoryBackupSchema, toolUpdateSchema } from '@/lib/tool-directory-schema';

const validTool = {
  name: '示例工具',
  description: '用于验证工具目录输入的示例工具。',
  category: 'business-support' as const,
  href: ' https://example.com/tool ',
  icon: 'store' as const,
  status: 'active' as const,
  tags: ['updated'] as const,
};

describe('tool directory input schemas', () => {
  it('规范化名称、简介和 HTTPS 链接', () => {
    expect(toolCreateSchema.parse(validTool)).toMatchObject({
      name: '示例工具',
      description: '用于验证工具目录输入的示例工具。',
      href: 'https://example.com/tool',
    });
  });

  it('要求可用工具使用公网 HTTPS 链接，非可用状态可以没有链接', () => {
    expect(toolCreateSchema.safeParse({ ...validTool, href: 'http://example.com/tool' }).success).toBe(false);
    expect(toolCreateSchema.safeParse({ ...validTool, href: 'https://127.0.0.1/tool' }).success).toBe(false);
    expect(toolCreateSchema.safeParse({ ...validTool, status: 'beta', href: null }).success).toBe(false);
    expect(toolCreateSchema.safeParse({ ...validTool, status: 'maintenance', href: null }).success).toBe(true);
    expect(toolCreateSchema.safeParse({ ...validTool, status: 'coming_soon', href: null }).success).toBe(true);
    expect(toolCreateSchema.safeParse({ ...validTool, status: 'disabled', href: null }).success).toBe(true);
  });

  it('只接受当前五种标签并拒绝已经删除的类型字段', () => {
    expect(toolCreateSchema.safeParse({
      ...validTool,
      tags: ['free', 'paid', 'popular', 'updated', 'latest'],
    }).success).toBe(true);
    expect(toolCreateSchema.safeParse({ ...validTool, tags: ['recommended'] }).success).toBe(false);
    expect(toolCreateSchema.safeParse({ ...validTool, kind: 'open' }).success).toBe(false);
  });

  it('拒绝重复标签、未知字段和空更新', () => {
    expect(toolCreateSchema.safeParse({ ...validTool, tags: ['free', 'free'] }).success).toBe(false);
    expect(toolCreateSchema.safeParse({ ...validTool, extra: true }).success).toBe(false);
    expect(toolUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('只接受完整且可恢复的工具中心备份', () => {
    const backup = {
      type: 'hot2-tool-directory-backup',
      version: 1,
      exportedAt: '2026-08-09T00:00:00.000Z',
      categories: [
        { id: 'business-support', name: '业务支持', sortOrder: 0 },
        { id: 'geo-location', name: '地理位置', sortOrder: 1 },
        { id: 'data-analysis', name: '数据分析', sortOrder: 2 },
        { id: 'network-planning', name: '点位分析', sortOrder: 3 },
        { id: 'other-tools', name: '其他工具', sortOrder: 4 },
      ],
      tools: [{
        id: 'tool-1',
        ...validTool,
        href: 'https://example.com/tool',
        tags: ['updated'],
        sortOrder: 0,
        archivedAt: null,
      }],
    };
    expect(toolDirectoryBackupSchema.safeParse(backup).success).toBe(true);
    expect(toolDirectoryBackupSchema.safeParse({ ...backup, categories: backup.categories.slice(1) }).success).toBe(false);
    expect(toolDirectoryBackupSchema.safeParse({ ...backup, tools: [{ ...backup.tools[0], status: 'active', href: null }] }).success).toBe(false);
  });
});
