/**
 * prompts.ts 功能测试
 */

import { describe, it, expect } from 'vitest';
import { buildStep2Prompt } from '@/lib/prompts';

describe('buildStep2Prompt', () => {
  const blocks = {
    blockAd: '',
    blockEventScore: '',
    blockCategory: '',
    blockRelevance: '',
    blockContentScore: '',
    blockKeyPoints: '',
    blockSummary: '',
    blockTags: '',
    blockBrand: '',
  };

  it('正常替换 {content} 占位符', () => {
    const content = '瑞幸咖啡在新线城市持续扩张。';
    const prompt = buildStep2Prompt(blocks, content);
    expect(prompt).toContain(content);
    expect(prompt).not.toContain('{content}');
  });

  it('content 中的 $& 不应被 replace 模板解析', () => {
    const content = '价格 $& 门店 $& 扩张';
    const prompt = buildStep2Prompt(blocks, content);
    expect(prompt).toContain(content);
    expect(prompt).not.toContain('{content}');
    // 不应出现把 {content} 自身替换成 $& 后的污染文本
    expect(prompt).not.toContain('价格 {content} 门店');
  });

  it('content 中的 $\\u0027 不应被替换模板解析', () => {
    const content = "it's $\u0027 test";
    const prompt = buildStep2Prompt(blocks, content);
    expect(prompt).toContain(content);
  });

  it('自定义评判块应覆盖默认块', () => {
    const custom = { ...blocks, blockAd: '自定义广告判定：只要提到加盟就视为广告' };
    const prompt = buildStep2Prompt(custom, '正文');
    expect(prompt).toContain('自定义广告判定');
  });
});
