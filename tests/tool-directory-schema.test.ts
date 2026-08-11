import { describe, expect, it } from 'vitest';
import {
  toolCategoryCreateSchema,
  toolCategoryReorderSchema,
  toolCategoryUpdateSchema,
  toolCreateSchema,
  toolDirectorySnapshotSchema,
  toolUpdateSchema,
} from '@/lib/tool-directory-schema';

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
    expect(toolCreateSchema.safeParse({ ...validTool, status: 'beta', href: 'https://example.com/tool' }).success).toBe(false);
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

  it('工具分类支持运行时动态 ID，拒绝空分类', () => {
    expect(toolCreateSchema.safeParse({ ...validTool, category: 'custom-tools' }).success).toBe(true);
    expect(toolCreateSchema.safeParse({ ...validTool, category: '  ' }).success).toBe(false);
  });

  it('接受包含动态分类与可选 hidden 的可恢复快照，并校验引用一致性', () => {
    const snapshot = {
      categories: [
        { id: 'business-support', name: '业务支持', sortOrder: 0 },
        { id: 'custom-tools', name: '自定义分类', sortOrder: 1, hidden: true },
      ],
      tools: [{
        id: 'tool-1',
        ...validTool,
        category: 'custom-tools',
        href: 'https://example.com/tool',
        tags: ['updated'],
        sortOrder: 0,
        archivedAt: null,
      }],
    };
    expect(toolDirectorySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(toolDirectorySnapshotSchema.safeParse({ ...snapshot, categories: [] }).success).toBe(false);
    expect(toolDirectorySnapshotSchema.safeParse({
      ...snapshot,
      tools: [{ ...snapshot.tools[0], category: 'missing-category' }],
    }).success).toBe(false);
    expect(toolDirectorySnapshotSchema.safeParse({
      ...snapshot,
      categories: [
        { id: 'custom-tools', name: '自定义分类', sortOrder: 0 },
        { id: 'custom-tools', name: '业务支持', sortOrder: 1 },
      ],
    }).success).toBe(false);
    expect(toolDirectorySnapshotSchema.safeParse({
      ...snapshot,
      categories: [{ id: 'Business Support', name: '自定义分类', sortOrder: 0 }],
    }).success).toBe(false);
    expect(toolDirectorySnapshotSchema.safeParse({
      ...snapshot,
      tools: [{ ...snapshot.tools[0], status: 'active', href: null }],
    }).success).toBe(false);
  });

  it('分类创建校验 slug 格式与必填字段', () => {
    expect(toolCategoryCreateSchema.safeParse({ id: 'custom-tools', name: '自定义分类' }).success).toBe(true);
    expect(toolCategoryCreateSchema.safeParse({ id: 'Business Support', name: '自定义分类' }).success).toBe(false);
    expect(toolCategoryCreateSchema.safeParse({ id: '123abc', name: '自定义分类' }).success).toBe(false);
    expect(toolCategoryCreateSchema.safeParse({ id: 'custom-tools' }).success).toBe(false);
    expect(toolCategoryCreateSchema.safeParse({ id: 'custom-tools', name: '自定义分类', extra: true }).success).toBe(false);
  });

  it('分类更新允许只改名称或只改隐藏状态，且至少提供一项', () => {
    expect(toolCategoryUpdateSchema.safeParse({ name: '新名称' }).success).toBe(true);
    expect(toolCategoryUpdateSchema.safeParse({ hidden: true }).success).toBe(true);
    expect(toolCategoryUpdateSchema.safeParse({ name: '新名称', hidden: false }).success).toBe(true);
    expect(toolCategoryUpdateSchema.safeParse({ name: '' }).success).toBe(false);
    expect(toolCategoryUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('分类排序接受任意非空 ID', () => {
    expect(toolCategoryReorderSchema.safeParse({ id: 'custom-tools', direction: 'up' }).success).toBe(true);
    expect(toolCategoryReorderSchema.safeParse({ id: '', direction: 'up' }).success).toBe(false);
  });
});
