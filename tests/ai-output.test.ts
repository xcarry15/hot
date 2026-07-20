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
  event_action: '正式开业',
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
    expect(parsed.event_key).toBe('测试品牌/正式开业/上海首店');
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

  it('缺少核心评分字段时拒绝结果', () => {
    expect(() => parseAiAnalysisOutput(JSON.stringify({ summary: '没有评分' }))).toThrow();
  });

  it('缺少完整事件身份时拒绝结果，避免用弱键进入聚类', () => {
    expect(() => parseAiAnalysisOutput(JSON.stringify({
      ...validOutput,
      event_object: '',
    }))).toThrow('完整事件身份');
  });
});
