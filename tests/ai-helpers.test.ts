/**
 * ai-helpers.ts 功能测试
 */

import { describe, it, expect } from 'vitest';
import {
  buildSystemContent,
  extractJsonObject,
  pickStringArray,
} from '@/lib/ai-helpers';
import { DEFAULT_SYSTEM_PROMPT, JSON_SUFFIX } from '@/lib/prompts';

describe('buildSystemContent', () => {
  it('空自定义 system prompt 回退到默认', () => {
    expect(buildSystemContent('')).toContain(DEFAULT_SYSTEM_PROMPT);
    expect(buildSystemContent('   ')).toContain(DEFAULT_SYSTEM_PROMPT);
    expect(buildSystemContent('')).toContain('硬性证据边界');
    expect(buildSystemContent('').endsWith(JSON_SUFFIX)).toBe(true);
  });

  it('非空自定义 system prompt 仍追加证据边界和 JSON_SUFFIX', () => {
    const custom = '你是营销专家';
    expect(buildSystemContent(custom)).toContain(custom);
    expect(buildSystemContent(custom)).toContain('不得把推测、动机或道德判断写成事实');
    expect(buildSystemContent(custom).endsWith(JSON_SUFFIX)).toBe(true);
  });
});

describe('extractJsonObject', () => {
  it('纯 JSON 响应直接解析', () => {
    const text = '{"is_ad":false,"score":80}';
    expect(extractJsonObject(text)).toEqual({ is_ad: false, score: 80 });
  });

  it('解析 markdown json 代码块', () => {
    const text = '```json\n{"is_ad":false,"score":80}\n```';
    expect(extractJsonObject(text)).toEqual({ is_ad: false, score: 80 });
  });

  it('markdown 代码块内有额外说明时取最外层 JSON', () => {
    const text = '```json\n这里是结果：\n{"is_ad":false,"score":80}\n```';
    expect(extractJsonObject(text)).toEqual({ is_ad: false, score: 80 });
  });

  it('多个 JSON 对象时取第一个完整对象', () => {
    const text = '{"a":1} some text {"b":2}';
    expect(extractJsonObject(text)).toEqual({ a: 1 });
  });

  it('嵌套 JSON 对象能正确匹配括号', () => {
    const text = '{"outer":{"inner":1},"arr":[1,2]}';
    expect(extractJsonObject(text)).toEqual({ outer: { inner: 1 }, arr: [1, 2] });
  });

  it('无 JSON 时抛出标准化错误', () => {
    expect(() => extractJsonObject('just plain text')).toThrow('LLM 响应中未找到 JSON 片段');
  });

  it('非法 JSON 时抛出解析错误', () => {
    expect(() => extractJsonObject('{invalid}')).toThrow('LLM 响应 JSON 解析失败');
  });
});

describe('pickStringArray', () => {
  it('过滤非字符串并裁剪', () => {
    expect(pickStringArray(['a', 1, 'b', 'c'], 2)).toEqual(['a', 'b']);
  });

  it('非数组返回空', () => {
    expect(pickStringArray('a', 2)).toEqual([]);
  });
});

