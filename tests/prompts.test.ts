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
    expect(prompt).toContain('执行顺序：广告判定 → 事件身份 → 要点提取 → 洞察 → 事件评分 → 内容评分 → 行业分类 → 相关度 → 品牌提取。');
    expect(prompt).toContain('评分不受本地权重、公开/推送阈值或文风影响');
    expect(prompt).toContain('<<<ARTICLE>>>');
    expect(prompt).toContain('不编造事实');
    expect(prompt).toContain('event_subjects');
    expect(prompt).toContain('event_action');
    expect(prompt).toContain('event_object');
    expect(prompt).toContain('原子动作词');
    expect(prompt).toContain('最多 16 个汉字');
    expect(prompt).toContain('一个辨识词或短语');
    expect(prompt).toContain('brand 只服务展示/搜索');
    expect(prompt).toContain('不得反向覆盖 event_subjects');
    expect(prompt).toContain('不得高于 60');
    expect(prompt).toContain('事件身份硬约束（不可被评判块覆盖）');
    expect(prompt).toContain('聚合快讯只能选一个子事件');
    expect(prompt).toContain('不得跨条目拼接');
    expect(prompt).toContain('尚在传闻、洽谈、研究或未落地的交易');
    expect(prompt).toContain('必须写“终止合作”');
    expect(prompt).toContain('确实没有可定位具体事件');
    expect(prompt).toContain('event_subjects 输出 []');
  });

  it('广告硬约束避免把劳动保障事实误判为软文', () => {
    const custom = { ...blocks, blockAd: '自定义广告块' };
    const prompt = buildStep2Prompt(custom, '京东为骑手缴纳五险一金');
    expect(prompt).toContain('员工福利、劳动保障、五险一金');
    expect(prompt).toContain('不能仅因信息由企业发布或对品牌有利就判为广告');
    expect(prompt).toContain('仍按全文核心目的判断');
    expect(prompt).toContain('不得仅凭关键词自动判为非广告');
  });

  it('事件身份不把开头引子误当成整篇文章的重复事件', () => {
    const prompt = buildStep2Prompt(blocks, '文章以某次开店为引子，正文分析整个赛道。');
    expect(prompt).toContain('该事实只是引子，不代表整篇文章');
    expect(prompt).toContain('event_score 必须为 0-9 并留空事件身份');
  });

  it('提高重要人事变动和规模化开关店的事件分', () => {
    const prompt = buildStep2Prompt(blocks, '正文');
    expect(prompt).toContain('创始人/CEO级人事突变');
    expect(prompt).toContain('千店级以上闭店或万店规模达成');
    expect(prompt).toContain('基层人事变动、单店开闭、常规节日营销、新品上新');
  });
});
