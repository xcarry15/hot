import { db } from './db';
import type { Article } from '@prisma/client';
import { AIClientError, createChatCompletion, getAISettings } from './ai-client';
import type { AISettings } from './ai-client';
import type { ChatMessage } from './ai-client';
import { fetchArticleDetail } from './detail-fetcher';
import { cleanContentMarkdown, extractArticleBody, meaningfulTextLength } from './cleaner';
import { MIN_MEANINGFUL_CHARS } from './shared/content-policy';
import { buildStep2Prompt } from './prompts';
import {
  buildSystemContent,
  extractJsonObject,
  pickStringArray,
  pickTagArray,
  type TagItem,
} from './ai-helpers';
import { assertNotAborted } from './worker-stop';
import { advanceJobProgress, startJobStage } from './job-progress';
import { z } from 'zod';
import { applyScorePolicy } from './score-policy';
import { refreshPublicPublication } from './public-publication-service';
import { createHash } from 'node:crypto';
import { buildAiResetDataForArticle } from './article-ai-reset';
import {
  buildArticleAiSnapshot,
  buildEffectiveScoreUpdate,
  mergeAiResultWithManualOverrides,
  parseManualOverrides,
  type ArticleAiSnapshot,
  type ManualCalibrationValues,
} from './article-calibration';
import { recalculateArticleEvent } from './event-service';

// v8：精简、口语化、多样化的行业洞察。
const PROMPT_VERSION = 'v8';

const analysisSchema = z.object({
  event_score: z.number().int().min(0).max(100),
  content_score: z.number().int().min(0).max(100),
  relevance: z.number().int().min(0).max(100),
  is_ad: z.boolean(),
  ad_probability: z.number().int().min(0).max(100),
  confidence: z.number().int().min(0).max(100),
  category: z.enum(['餐饮', '零售', '品牌', '加盟', '食品', '供应链', '政策', '资本', '消费者', '科技', '人事', '其他']),
  summary: z.string().min(1).max(600),
  brand: z.union([z.array(z.string()), z.string()]),
  tags: z.array(z.union([z.string(), z.object({ n: z.string(), t: z.string() })])).max(3),
  key_points: z.array(z.string()).max(5),
});

// AI 失败最大重试次数。超过后标 skipped 放弃，防止 provider 持续故障时无限重试烧 token。
const AI_MAX_RETRIES = 5;

/**
 * Deep analysis with full article content
 */
async function deepAnalyze(article: Article, settings: AISettings, signal?: AbortSignal): Promise<{
  eventScore: number;
  isAd: boolean;
  relevance: number;
  category: string;
  contentScore: number;
  adProbability: number;
  confidence: number;
  model: string;
  provider: string;
  promptHash: string;
  summary: string;
  brand: string;
  tags: TagItem[];
  keyPoints: string[];
} | null> {
  // P0-2: Lazy fetch detail if not already available
  let content = article.cleanContent || '';
  if (!content || content.length < 100) {
    // 已确认抓取失败（fetchStatus='failed'）→ 不再尝试重抓，直接用现有 content
    // 避免每次 AI 处理都白烧 3 次重试的 token。
    if (article.fetchStatus === 'failed') {
      content = content || '';
    } else {
      const rawDetail = await fetchArticleDetail(article.id, 2, signal);
      // Use markdown format for AI (preserves heading structure)
      content = cleanContentMarkdown(rawDetail || '');
    }
    // 重抓后仍然为空 → 跳过 AI
    const textLen = meaningfulTextLength(content);
    if (textLen < MIN_MEANINGFUL_CHARS) return null;
  } else {
    // 优先用缓存的 articleBody（fetch 阶段已提取一次），避免每次 AI 都重新跑 extractArticleBody
    const articleBody = article.articleBody || extractArticleBody(article.rawContent || content);
    content = cleanContentMarkdown(articleBody);
  }

  const textContent = content
    .replace(/<[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  // 长文同时保留开头与结尾：导语通常给背景，尾部常包含数据、限制条件和风险。
  const maxChars = settings.step2ContentMaxChars;
  const truncated = textContent.length <= maxChars
    ? textContent
    : `${textContent.slice(0, Math.floor(maxChars * 0.7))}\n\n[正文中段已截断]\n\n${textContent.slice(-Math.ceil(maxChars * 0.3))}`;

  try {
    // 块化拼接:公共框架 + 内容评分块 + 要点块 + 点评块 → 完整 Step2 prompt
    const prompt = buildStep2Prompt(settings, truncated);

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemContent(settings.systemPrompt) },
      { role: 'user', content: prompt },
    ];

    const result = await createChatCompletion(messages, { signal });
    assertNotAborted(signal);
    const parsed = analysisSchema.parse(extractJsonObject(result.content));
    const brandItems = Array.isArray(parsed.brand)
      ? parsed.brand
      : parsed.brand.split(/[|,，]/);
    return {
      eventScore: parsed.event_score,
      isAd: parsed.is_ad,
      adProbability: parsed.ad_probability,
      confidence: parsed.confidence,
      relevance: parsed.relevance,
      category: parsed.category,
      contentScore: parsed.content_score,
      summary: parsed.summary,
      brand: JSON.stringify(brandItems.map(x => x.trim()).filter(Boolean).slice(0, 2)),
      tags: pickTagArray(parsed.tags, 3),
      // key_points 上限 5 条(默认块要求 1~5 条精炼硬事实)
      keyPoints: pickStringArray(parsed.key_points, 5),
      model: result.model,
      provider: result.provider,
      promptHash: createHash('sha256').update(messages.map(x => `${x.role}:${x.content}`).join('\n')).digest('hex'),
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof AIClientError) throw err;
    // API 失败（如 429/5xx/网络错误）或 JSON 解析失败 → 返回 null，
    // 由 processWithAI 写入 aiStatus='failed'，留在重试池等待下一轮。
    console.error(`[ai] deepAnalyze failed for "${article.title}":`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Process an article with AI (单步完成全部分析)
 * 已完成 AI 的文章（aiStatus='done'）会被 analyzeAllPending 过滤掉，不会再进来。
 *
 * @param article 从 analyzeAllPending 批量查询中传递的文章对象（已 select 所需字段，避免 N+1 查询）
 * 打分：原始特征经本地策略引擎加权，并按广告概率扣分/封顶。
 */
export type AIProcessResult = { status: 'done' | 'skipped' | 'failed'; errorKind?: string; globalError?: boolean };
type AIProcessArticle = Pick<Article, 'id' | 'title' | 'aiStatus' | 'cleanContent' | 'publishedAt'> &
  Partial<Omit<Article, 'id' | 'title' | 'aiStatus' | 'cleanContent' | 'publishedAt' | 'summary'>> & {
    summary: string | null;
  };

export async function processWithAI(article: AIProcessArticle, signal?: AbortSignal): Promise<AIProcessResult> {
  const { id: articleId } = article;
  assertNotAborted(signal);

  // 已完成 → 不再处理
  if (article.aiStatus === 'done') return { status: 'done' };

  // Content quality gate: skip AI if content is too short, regardless of fetchStatus
  const contentLength = meaningfulTextLength(article.cleanContent || '');
  if (contentLength < MIN_MEANINGFUL_CHARS && !article.summary) {
    console.log(`[processWithAI] Skipping article ${articleId}: insufficient content (${contentLength} chars)`);
    await db.article.update({
      where: { id: articleId },
      data: {
        aiStatus: 'skipped',
        skipReason: `内容不足（< ${MIN_MEANINGFUL_CHARS} 字符）`,
      },
    });
    await refreshPublicPublication(articleId, db);
    return { status: 'skipped' };
  }

  // 开头统一跑，processWithAI 不再单独查。

  // 读取设置，获取动态权重（默认事件重要性 70 / 内容质量 30）。
  const settings = await getAISettings();
  const { weightEvent, weightContent } = settings;

  // Deep analysis: 一次性生成全部字段（复用已查询的 article 对象，无额外 DB 查询）
  let step2;
  try {
    step2 = await deepAnalyze(article as Article, settings, signal);
  } catch (error) {
    if (error instanceof AIClientError && error.global) {
      return { status: 'failed', errorKind: error.kind, globalError: true };
    }
    throw error;
  }
  assertNotAborted(signal);

  if (step2) {
    // v9：拓展情报价值为主，证据完整度校准；高广告概率按证据质量分级封顶。
    const policy = applyScorePolicy(
      step2.eventScore, step2.contentScore, step2.adProbability,
      step2.isAd, weightEvent, weightContent,
    );
    const aiSnapshot: ArticleAiSnapshot = {
      relevance: step2.relevance,
      summary: step2.summary,
      brand: step2.brand,
      category: step2.category,
      tags: JSON.stringify(step2.tags),
      keyPoints: JSON.stringify(step2.keyPoints),
      score: policy.finalScore,
      rawScore: policy.rawScore,
      eventScore: step2.eventScore,
      contentScore: step2.contentScore,
      adProbability: step2.adProbability,
      aiConfidence: step2.confidence,
      isAd: step2.isAd,
      model: step2.model,
      provider: step2.provider,
      promptHash: step2.promptHash,
      promptVersion: PROMPT_VERSION,
    };
    const effective = mergeAiResultWithManualOverrides(
      aiSnapshot,
      article as ManualCalibrationValues,
      article.manualOverrides,
    );
    const effectiveScore = buildEffectiveScoreUpdate({
      eventScore: effective.eventScore,
      contentScore: effective.contentScore,
      adProbability: effective.adProbability,
      isAd: effective.isAd,
      weightEvent,
      weightContent,
    });

    assertNotAborted(signal);
    await db.article.update({
      where: { id: articleId },
      data: {
        relevance: effective.relevance,
        category: effective.category,
        summary: effective.summary,
        brand: effective.brand,
        tags: effective.tags,
        keyPoints: effective.keyPoints,
        ...effectiveScore,
        eventScore: effective.eventScore,
        contentScore: effective.contentScore,
        adProbability: effective.adProbability,
        aiConfidence: step2.confidence,
        aiModel: step2.model,
        aiProvider: step2.provider,
        promptHash: step2.promptHash,
        isAd: effective.isAd,
        promptVersion: PROMPT_VERSION,
        aiStatus: 'done',
        aiSnapshot: buildArticleAiSnapshot(aiSnapshot),
        skipReason: null,
      },
    });

    await refreshPublicPublication(articleId, db, { contentChanged: true });
    await recalculateArticleEvent(articleId);
    return { status: 'done' };
  } else {
    // AI 调用完全失败 — 指数退避 + 失败计数。
    // provider 故障时整批 failed，nextAiRetryAt 防止下一轮 cron 全量重试烧 token。
    // 超限（≥5 次）标 skipped 放弃，避免死循环占用重试池。
    const retryCount = (article.aiRetryCount ?? 0) + 1;
    if (retryCount >= AI_MAX_RETRIES) {
      assertNotAborted(signal);
      await db.article.update({
        where: { id: articleId },
        data: {
          aiStatus: 'skipped',
          aiRetryCount: retryCount,
          nextAiRetryAt: null,
          skipReason: `AI 连续失败 ${retryCount} 次，已放弃`,
          ...(parseManualOverrides(article.manualOverrides).includes('summary') ? {} : { summary: '[AI 处理失败]' }),
        },
      });
    } else {
      const backoffMs = Math.min(Math.pow(2, retryCount) * 60 * 1000, 6 * 60 * 60 * 1000);
      assertNotAborted(signal);
      await db.article.update({
        where: { id: articleId },
        data: {
          aiStatus: 'failed',
          aiRetryCount: retryCount,
          nextAiRetryAt: new Date(Date.now() + backoffMs),
          ...(parseManualOverrides(article.manualOverrides).includes('summary') ? {} : { summary: '[AI 处理失败]' }),
        },
      });
    }
    await refreshPublicPublication(articleId, db);
    return { status: 'failed', errorKind: 'content' };
  }
}

/**
 * Re-process an article with AI (manual trigger)
 */
export async function reprocessWithAI(
  articleId: string,
  signal?: AbortSignal,
  jobId?: string,
): Promise<AIProcessResult | null> {
  assertNotAborted(signal);
  // 重置 AI 状态为 pending。
  // fetchStatus 仅在之前为 'failed' 时才重置（用户可能已修了源站/网络），
  // 已成功抓取的文章保留 fetchStatus='fetched'，避免"处理"步骤回退变灰。
  const articleData = await db.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      title: true,
      aiStatus: true,
      cleanContent: true,
      articleBody: true,
      rawContent: true,
      fetchStatus: true,
      publishedAt: true,
      createdAt: true,
      summary: true,
      relevance: true,
      category: true,
      brand: true,
      tags: true,
      keyPoints: true,
      score: true,
      eventScore: true,
      contentScore: true,
      rawScore: true,
      adProbability: true,
      aiConfidence: true,
      isAd: true,
      manualOverrides: true,
      aiSnapshot: true,
      manualCorrectedAt: true,
      aiRetryCount: true,
    },
  });
  if (!articleData) return null;
  if (jobId) {
    await startJobStage(jobId, { stage: 'ai', total: 1, currentItemLabel: articleData.title });
  }
  assertNotAborted(signal);
  await db.article.update({
    where: { id: articleId },
    data: {
      ...buildAiResetDataForArticle(articleData),
      fetchStatus: articleData.fetchStatus === 'failed' ? 'pending' : undefined,
    },
  });
  let result: AIProcessResult;
  try {
    result = await processWithAI({ ...articleData, aiStatus: 'pending', aiRetryCount: 0 } as Article, signal);
  } catch (error) {
    await refreshPublicPublication(articleId);
    throw error;
  }
  if (jobId) {
    await advanceJobProgress(jobId, {
      doneDelta: 1,
      errorDelta: result.status === 'failed' ? 1 : 0,
      currentItemLabel: articleData.title,
    });
  }
  return result;
}
