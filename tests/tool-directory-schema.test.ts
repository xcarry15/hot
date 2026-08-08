import { describe, expect, it } from 'vitest';
import { toolCreateSchema, toolUpdateSchema } from '@/lib/tool-directory-schema';

const validTool = {
  name: '示例工具',
  description: '用于验证工具目录输入的示例工具。',
  category: 'business-support' as const,
  href: ' https://example.com/tool ',
  icon: 'store' as const,
  kind: 'open' as const,
  status: 'active' as const,
  tags: ['recommended'] as const,
};

describe('tool directory input schemas', () => {
  it('规范化名称、简介和 HTTPS 链接', () => {
    expect(toolCreateSchema.parse(validTool)).toMatchObject({
      name: '示例工具',
      description: '用于验证工具目录输入的示例工具。',
      href: 'https://example.com/tool',
    });
  });

  it('要求正常工具使用公网 HTTPS 链接，停用工具可以没有链接', () => {
    expect(toolCreateSchema.safeParse({ ...validTool, href: 'http://example.com/tool' }).success).toBe(false);
    expect(toolCreateSchema.safeParse({ ...validTool, href: 'https://127.0.0.1/tool' }).success).toBe(false);
    expect(toolCreateSchema.safeParse({ ...validTool, status: 'disabled', href: null }).success).toBe(true);
  });

  it('拒绝重复标签、未知字段和空更新', () => {
    expect(toolCreateSchema.safeParse({ ...validTool, tags: ['free', 'free'] }).success).toBe(false);
    expect(toolCreateSchema.safeParse({ ...validTool, extra: true }).success).toBe(false);
    expect(toolUpdateSchema.safeParse({}).success).toBe(false);
  });
});
