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
    blockEventIdentity: '',
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

  it('公共框架明确执行顺序、评分独立性和缺失信息处理', () => {
    const prompt = buildStep2Prompt(blocks, '正文');
    expect(prompt).toContain('1. 确定核心主体和事件');
    expect(prompt).toContain('评分不受本地权重、公开/推送阈值或文风影响');
    expect(prompt).toContain('<<<ARTICLE>>>');
    expect(prompt).toContain('不编造事实');
    expect(prompt).toContain('event_subjects');
    expect(prompt).toContain('event_action');
    expect(prompt).toContain('event_object');
    expect(prompt).toContain('原子动作词');
    expect(prompt).toContain('最多 16 个汉字');
    expect(prompt).toContain('一个辨识词或短语');
    expect(prompt).toContain('不得高于 60');
    expect(prompt).toContain('事件身份硬约束（不可被评判块覆盖）');
  });

  it('提高重要人事变动和规模化开关店的事件分', () => {
    const prompt = buildStep2Prompt(blocks, '正文');
    expect(prompt).toContain('创始人/CEO级人事突变');
    expect(prompt).toContain('千店级以上闭店或万店规模达成');
    expect(prompt).toContain('基层人事变动、单店开闭、常规节日营销、新品上新');
  });
});
