import { describe, expect, it } from 'vitest';
import { toolCreateSchema, toolUpdateSchema } from '@/lib/tool-directory-schema';

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
});
