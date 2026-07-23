/**
 * ai.ts AI 失败路径回归测试
 *
 * 设计变更（commit 9f30d80）：删除 offlineClassify + FALLBACK_BRANDS 硬编码，
 * AI 失败时改写 aiStatus='failed' 留重试池，不再用规则打分伪装成 done。
 * 原因：fallback 分数会被当真实 AI 分数推送，污染推送池。
 *
 * 本测试验证新契约：
 *   - AI 失败 → aiStatus='failed'，不读品牌字典（offlineClassify 已删）
 *   - 不伪装成 done（不进推送池）
 *   - 不抛错（留重试池等下一轮）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  keywordFindMany: vi.fn(),
  articleFindUnique: vi.fn(),
  articleUpdate: vi.fn(),
  getAISettings: vi.fn(),
  buildStep2Prompt: vi.fn(),
  fetchArticleDetail: vi.fn(),
  cleanContentMarkdown: vi.fn(),
  extractArticleBody: vi.fn(),
  createChatCompletion: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    keyword: {
      findMany: mocks.keywordFindMany,
    },
    article: {
      findUnique: mocks.articleFindUnique,
      update: mocks.articleUpdate,
    },
  },
}));

vi.mock('@/lib/ai-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai-client')>()),
  getAISettings: mocks.getAISettings,
  createChatCompletion: mocks.createChatCompletion,
}));

vi.mock('@/lib/detail-fetcher', () => ({
  fetchArticleDetail: mocks.fetchArticleDetail,
}));

vi.mock('@/lib/cleaner', () => ({
  cleanContentMarkdown: mocks.cleanContentMarkdown.mockImplementation((s: string) => s),
  extractArticleBody: mocks.extractArticleBody.mockImplementation((s: string) => s),
  meaningfulTextLength: (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length,
}));

vi.mock('@/lib/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prompts')>()),
  buildStep2Prompt: mocks.buildStep2Prompt,
}));

vi.mock('@/lib/ai-helpers', () => ({
  buildSystemContent: vi.fn().mockReturnValue('system'),
  extractJsonObject: vi.fn().mockImplementation((value: string) => JSON.parse(value)),
  pickStringArray: vi.fn().mockReturnValue([]),
}));

vi.mock('@/lib/dedup', () => ({
  dedupAfterAI: vi.fn().mockResolvedValue({ isDuplicate: false, sharedCount: 0, sharedValues: [], skipReason: '' }),
}));

import * as aiModule from '@/lib/ai';

describe('AI 失败路径（offlineClassify 已删除）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.articleUpdate.mockResolvedValue({});
    // 触发失败路径：deepAnalyze → createChatCompletion 抛错
    mocks.createChatCompletion.mockRejectedValue(new Error('mock ai failure'));
    mocks.getAISettings.mockResolvedValue({
      weightEvent: 60,
      weightContent: 40,
      keywordMatchBonus: 5,
      step2ContentMaxChars: 5000,
    });
    mocks.buildStep2Prompt.mockReturnValue('prompt');
  });

  it('AI 失败 → 写 aiStatus=failed，不读品牌字典（offlineClassify 已删）', async () => {
    mocks.keywordFindMany.mockResolvedValue([
      { word: '测试品牌A' },
      { word: '测试品牌B' },
    ]);
    const longContent = '这是一段足够长的内容用于测试 AI 流程。'.repeat(5);
    mocks.articleFindUnique.mockResolvedValue({
      id: 't1',
      title: '测试品牌A 新店开业',
      cleanContent: longContent,
      aiStatus: 'pending',
    });

    await aiModule.processWithAI({
      id: 't1',
      title: '测试品牌A 新店开业',
      aiStatus: 'pending',
      cleanContent: longContent,
      summary: null,
      publishedAt: null,
    });

    // offlineClassify 已删 → 不应读品牌字典
    expect(mocks.keywordFindMany).not.toHaveBeenCalled();
    const updateCall = mocks.articleUpdate.mock.calls.find(
      c => c[0]?.where?.id === 't1'
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0].data.aiStatus).toBe('failed');
    expect(updateCall![0].data.summary).toBe('[AI 处理失败]');
    expect(updateCall![0].data.aiError).toBe('mock ai failure');
  });

  it('AI 失败时不伪装成 done（failed 不进推送池）', async () => {
    const longContent = '这是一段足够长的内容用于测试 AI 流程。'.repeat(5);
    mocks.articleFindUnique.mockResolvedValue({
      id: 't2',
      title: '瑞幸咖啡开店',
      cleanContent: longContent,
      aiStatus: 'pending',
    });

    await aiModule.processWithAI({
      id: 't2',
      title: '瑞幸咖啡开店',
      aiStatus: 'pending',
      cleanContent: longContent,
      summary: null,
      publishedAt: null,
    });

    const updateCall = mocks.articleUpdate.mock.calls.find(
      c => c[0]?.where?.id === 't2'
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0].data.aiStatus).not.toBe('done');
    expect(updateCall![0].data.aiStatus).toBe('failed');
    // 不写 promptVersion='offline'（offlineClassify 已删）
    expect(updateCall![0].data.promptVersion).toBeUndefined();
  });

  it('AI 失败时不抛错（留重试池等下一轮）', async () => {
    const longContent = '这是一段足够长的内容用于测试 AI 流程。'.repeat(5);
    mocks.articleFindUnique.mockResolvedValue({
      id: 't3',
      title: '瑞幸咖啡开店',
      cleanContent: longContent,
      aiStatus: 'pending',
    });

    await expect(aiModule.processWithAI({
      id: 't3',
      title: '瑞幸咖啡开店',
      aiStatus: 'pending',
      cleanContent: longContent,
      summary: null,
      publishedAt: null,
    })).resolves.not.toThrow();
  });

  it('无具体事件正常跳过，但保留模型与 Prompt 审计信息', async () => {
    const longContent = '这是一篇有足够正文的行业趋势文章。'.repeat(8);
    mocks.createChatCompletion.mockResolvedValue({
      content: JSON.stringify({
        event_score: 5,
        content_score: 78,
        relevance: 88,
        is_ad: false,
        ad_probability: 5,
        confidence: 82,
        category: '零售',
        summary: '便利店行业增长正从单纯开店转向经营单客价值。',
        brand: [],
        event_subjects: [],
        event_action: '',
        event_object: '',
        event_key_confidence: 0,
        key_points: ['行业增长逻辑发生变化'],
      }),
      model: 'audit-model',
      provider: 'opencode',
    });

    const result = await aiModule.processWithAI({
      id: 'trend-1',
      title: '便利店增长逻辑正在失效',
      aiStatus: 'pending',
      cleanContent: longContent,
      summary: null,
      publishedAt: null,
    });

    expect(result.status).toBe('skipped');
    const updateCall = mocks.articleUpdate.mock.calls.find(c => c[0]?.where?.id === 'trend-1');
    expect(updateCall?.[0].data).toMatchObject({
      aiStatus: 'skipped',
      skipReason: '无具体事件',
      aiModel: 'audit-model',
      aiProvider: 'opencode',
      eventKey: '',
      eventKeyConfidence: 0,
    });
    expect(updateCall?.[0].data.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(updateCall?.[0].data.aiSnapshot)).toMatchObject({
      eventScore: 5,
      contentScore: 78,
      model: 'audit-model',
      provider: 'opencode',
    });
  });

  it('多事件聚合稿也完成 AI 分析，不丢失软文与内容判断', async () => {
    const longContent = '聚合稿包含多条有效零售新闻，需要保留整体分析和广告判断。'.repeat(8);
    mocks.createChatCompletion.mockResolvedValue({
      content: JSON.stringify({
        event_score: 45,
        content_score: 62,
        relevance: 90,
        is_ad: false,
        ad_probability: 10,
        confidence: 78,
        category: '零售',
        summary: '文章汇总了多个彼此独立的零售事件。',
        brand: ['杉杉奥莱', '金粒门'],
        event_subjects: ['杉杉奥莱'],
        event_action: '计划开店',
        event_object: '西安首店',
        event_key_confidence: 55,
        key_points: ['聚合稿含多个独立事件'],
      }),
      model: 'audit-model',
      provider: 'opencode',
    });

    const result = await aiModule.processWithAI({
      id: 'digest-1',
      title: '联商头条：杉杉奥莱首进西安；金粒门浙江首店落地',
      aiStatus: 'pending',
      cleanContent: longContent,
      summary: null,
      publishedAt: null,
    });

    expect(result.status).toBe('skipped');
    expect(mocks.createChatCompletion).toHaveBeenCalledTimes(1);
    const updateCall = mocks.articleUpdate.mock.calls.find(c => c[0]?.where?.id === 'digest-1');
    expect(updateCall?.[0].data).toMatchObject({
      aiStatus: 'skipped',
      skipReason: '多事件聚合稿',
      aiModel: 'audit-model',
      aiProvider: 'opencode',
      eventSubjects: '[]',
      eventAction: '',
      eventObject: '',
      eventKey: '',
      eventKeyConfidence: 0,
    });
    expect(updateCall?.[0].data.aiSnapshot).not.toBe('{}');
  });
});
