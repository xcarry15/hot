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
  buildStep2Prompt: vi.fn(),
}));

vi.mock('@/lib/ai-helpers', () => ({
  buildSystemContent: vi.fn().mockReturnValue('system'),
  extractJsonObject: vi.fn().mockReturnValue({
    event_score: 50,
    is_ad: false,
    relevance: 70,
    category: '餐饮',
    content_score: 60,
    summary: 'test',
    brand: '测试品牌A',
    tags: ['t1'],
    key_points: ['p1'],
  }),
  pickStringArray: vi.fn().mockReturnValue([]),
  pickTagArray: vi.fn().mockReturnValue([]),
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
});
