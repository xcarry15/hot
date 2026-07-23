import { describe, expect, it } from 'vitest';
import { parseAiAnalysisOutput } from '@/lib/ai-output';

const validOutput = {
  event_score: 80,
  content_score: 70,
  relevance: 90,
  is_ad: false,
  ad_probability: 20,
  confidence: 85,
  category: '餐饮',
  summary: '这是一段长度达到约束的测试洞察。'.repeat(7),
  brand: ['测试品牌'],
  event_subjects: ['测试品牌'],
  event_action: '正式开店',
  event_object: '上海首店',
  event_key_confidence: 88,
  key_points: ['测试品牌新增门店并公布经营计划'],
};

describe('parseAiAnalysisOutput', () => {
  it('接受严格结构化结果', () => {
    expect(parseAiAnalysisOutput(JSON.stringify(validOutput))).toMatchObject(validOutput);
  });

  it('兼容 Markdown、未知字段和模型常见的宽松数组格式', () => {
    const parsed = parseAiAnalysisOutput(`\`\`\`json\n${JSON.stringify({
      ...validOutput,
      extra: true,
      event_subjects: undefined,
      event_action: undefined,
      event_object: undefined,
      event_key_confidence: undefined,
      event_identity: {
        subjects: '测试品牌',
        action: '正式开业',
        object: '上海首店',
        confidence: '91分',
      },
      summary: '较长但仍然有效的洞察。'.repeat(100),
      key_points: ['一条超过四十字但包含完整事实、主体、动作、时间和结果的要点'],
    })}\n\`\`\``);
    expect(parsed.event_subjects).toEqual(['测试品牌']);
    expect(parsed.event_key).toBe('测试品牌/正式开店/上海首店');
    expect(parsed.event_key_confidence).toBe(91);
    expect(parsed.summary.length).toBe(600);
    expect(parsed.key_points).toHaveLength(1);
  });

  it('归一化互相矛盾的广告字段和重复结果', () => {
    const parsed = parseAiAnalysisOutput(JSON.stringify({
      ...validOutput,
      is_ad: true,
      ad_probability: 20,
      key_points: ['重复', '重复'],
    }));
    expect(parsed.is_ad).toBe(false);
    expect(parsed.key_points).toEqual(['重复']);
  });

  it('可核验的劳动保障动作不因品牌自述误判为广告', () => {
    const parsed = parseAiAnalysisOutput(JSON.stringify({
      ...validOutput,
      event_score: 40,
      is_ad: true,
      ad_probability: 85,
      event_action: '缴纳五险一金',
      event_object: '全职骑手快递小哥',
      summary: '京东每年投入超百亿，为全职骑手和快递员缴纳五险一金并签署劳动合同。',
      key_points: ['京东为15万全职骑手缴纳五险一金'],
    }));
    expect(parsed.is_ad).toBe(false);
    expect(parsed.ad_probability).toBe(19);
  });

  it('公益宣传仍尊重模型的广告判断', () => {
    const parsed = parseAiAnalysisOutput(JSON.stringify({
      ...validOutput,
      event_score: 20,
      is_ad: true,
      ad_probability: 85,
      event_action: '捐赠救援',
      event_object: '品牌公益物资',
      summary: '全文围绕品牌公益活动与品牌形象展开，缺少独立行业信息。',
      key_points: ['品牌发布捐赠活动宣传稿'],
    }));
    expect(parsed.is_ad).toBe(true);
    expect(parsed.ad_probability).toBe(85);
  });

  it('缺少核心评分字段时拒绝结果', () => {
    expect(() => parseAiAnalysisOutput(JSON.stringify({ summary: '没有评分' }))).toThrow();
  });

  it('缺少完整事件身份时拒绝结果，避免用弱键进入聚类', () => {
    expect(() => parseAiAnalysisOutput(JSON.stringify({
      ...validOutput,
      event_object: '',
    }))).toThrow('完整事件身份');
  });

  it('纯观点文章缺少事件身份时识别为无具体事件', () => {
    const parsed = parseAiAnalysisOutput(JSON.stringify({
      ...validOutput,
      event_score: 5,
      event_subjects: [],
      event_action: '',
      event_object: '',
    }));
    expect(parsed.event_score).toBe(5);
    expect(parsed.event_key).toBe('');
    expect(parsed.summary).toBe(validOutput.summary);
  });

  it('低事件分即使模型编造完整身份也识别为无具体事件', () => {
    const parsed = parseAiAnalysisOutput(JSON.stringify({
      ...validOutput,
      event_score: 5,
      event_subjects: ['山姆'],
      event_action: '评估产品',
      event_object: '供应商渗透率',
    }));
    expect(parsed.event_subjects).toEqual([]);
    expect(parsed.event_action).toBe('');
    expect(parsed.event_object).toBe('');
  });

  it('宽泛或多动作身份会自动降级置信度', () => {
    const parsed = parseAiAnalysisOutput(JSON.stringify({
      ...validOutput,
      event_action: '推进战略升级并调整经营重心',
      event_object: '行业趋势',
      event_key_confidence: 95,
    }));
    expect(parsed.event_key_confidence).toBe(60);
  });
});
