import { describe, expect, it } from 'vitest';
import {
  sourceCreateSchema,
  sourceTestSchema,
  sourceUpdateSchema,
} from '@/lib/source-schema';
import { dispatchParser, UnknownParserTypeError } from '@/lib/parser-registry';

describe('source input schemas', () => {
  it('接受完整创建输入并规范化名称、URL', () => {
    const parsed = sourceCreateSchema.parse({
      name: '  示例源 ',
      type: 'rss',
      url: ' https://example.com/feed.xml ',
      parserConfig: { feedUrl: 'https://example.com/feed.xml' },
      enabled: false,
    });

    expect(parsed).toMatchObject({
      name: '示例源',
      type: 'rss',
      url: 'https://example.com/feed.xml',
      enabled: false,
    });
  });

  it('拒绝未知 type、非 http(s) URL 和未知字段', () => {
    expect(sourceCreateSchema.safeParse({ name: 'x', type: 'unknown', url: 'https://example.com' }).success).toBe(false);
    expect(sourceCreateSchema.safeParse({ name: 'x', url: 'example.com' }).success).toBe(false);
    expect(sourceCreateSchema.safeParse({ name: 'x', url: 'https://example.com', extra: true }).success).toBe(false);
  });

  it('更新允许仅提交 enabled，但拒绝空更新', () => {
    expect(sourceUpdateSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(sourceUpdateSchema.safeParse({}).success).toBe(false);
    expect(sourceUpdateSchema.safeParse({ type: 'unknown' }).success).toBe(false);
  });

  it('测试接口使用同一 type/url/parserConfig 契约', () => {
    expect(sourceTestSchema.parse({ type: 'html', url: 'https://example.com' })).toMatchObject({
      type: 'html',
      url: 'https://example.com',
      parserConfig: '{}',
    });
    expect(sourceTestSchema.safeParse({ type: 'html', url: 'https://example.com', parserConfig: [] }).success).toBe(false);
  });

  it('解析器注册表拒绝未知类型，不静默回退 HTML', async () => {
    await expect(dispatchParser('unknown', 'https://example.com', '{}')).rejects.toBeInstanceOf(UnknownParserTypeError);
  });
});
