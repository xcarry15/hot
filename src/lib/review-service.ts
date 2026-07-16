import { db } from '@/lib/db';
import { getSetting, SETTING_KEYS } from '@/lib/settings';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { refreshPublicPublication, refreshPublicPublications, updatePublicPublicationSetting } from '@/lib/public-publication-service';
import { captureInboxSnapshot } from '@/lib/inbox-snapshot-service';
import { buildAiResetData } from '@/lib/article-duplicate-state';

export const REVIEW_STATUSES = ['unreviewed', 'important', 'general', 'irrelevant'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_REASON_TAGS = [
  'low_score',
  'ad_misclassification',
  'wrong_brand',
  'keyword_ambiguity',
  'poor_summary',
] as const;
export type ReviewReasonTag = (typeof REVIEW_REASON_TAGS)[number];

const PUBLIC_RULES = ['auto', 'public', 'hidden'] as const;
type PublicRule = (typeof PUBLIC_RULES)[number];

function parseRule(value: string, fallback: PublicRule): PublicRule {
  return PUBLIC_RULES.includes(value as PublicRule) ? value as PublicRule : fallback;
}

function parseReasonTags(value: unknown): ReviewReasonTag[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is ReviewReasonTag => REVIEW_REASON_TAGS.includes(tag as ReviewReasonTag));
}

async function getReviewRules(): Promise<Record<ReviewStatus, PublicRule>> {
  const [important, general, irrelevant] = await Promise.all([
    getSetting(SETTING_KEYS.PUBLIC_IMPORTANT_RULE),
    getSetting(SETTING_KEYS.PUBLIC_GENERAL_RULE),
    getSetting(SETTING_KEYS.PUBLIC_IRRELEVANT_RULE),
  ]);
  return {
    unreviewed: 'auto',
    important: parseRule(important, 'public'),
    general: parseRule(general, 'auto'),
    irrelevant: parseRule(irrelevant, 'hidden'),
  };
}

export async function reviewArticle(input: {
  articleId: string;
  status: ReviewStatus;
  reasonTags?: unknown;
}) {
  if (!REVIEW_STATUSES.includes(input.status)) throw new Error('无效的归类状态');
  const article = await db.article.findUnique({
    where: { id: input.articleId },
    select: { id: true, duplicateStatus: true, aiStatus: true },
  });
  if (!article) return null;

  const rules = await getReviewRules();
  const pinHours = Math.max(1, Math.min(720, Number(await getSetting(SETTING_KEYS.PUBLIC_PIN_HOURS)) || 24));
  const isImportant = input.status === 'important';
  const restoreDuplicate = isImportant && article.duplicateStatus === 'duplicate';
  // 重要归类必须突破最低分并公开；其它归类遵循设置中的映射。
  const publicOverride = isImportant ? 'public' : rules[input.status];
  const now = new Date();

  const updated = await db.$transaction(async tx => {
    const updatedArticle = await tx.article.update({
      where: { id: input.articleId },
      data: {
        reviewStatus: input.status,
        reviewReasonTags: JSON.stringify(parseReasonTags(input.reasonTags)),
        reviewedAt: now,
        publicOverride,
        pinUntil: isImportant ? new Date(now.getTime() + pinHours * 60 * 60 * 1000) : null,
        ...(restoreDuplicate ? {
          ...buildAiResetData({ dedupOverride: true }),
        } : {}),
      },
      select: {
        id: true,
        reviewStatus: true,
        publicOverride: true,
        pinUntil: true,
        duplicateStatus: true,
        aiStatus: true,
      },
    });
    await refreshPublicPublication(input.articleId, tx, { contentChanged: true });
    return updatedArticle;
  });
  invalidatePublicArticleCache();
  await captureInboxSnapshot().catch(() => undefined);
  return { article: updated, restoredDuplicate: restoreDuplicate };
}

export async function reviewArticles(input: {
  articleIds: string[];
  status: ReviewStatus;
  reasonTags?: unknown;
}) {
  if (!REVIEW_STATUSES.includes(input.status)) throw new Error('无效的归类状态');
  const ids = [...new Set(input.articleIds.filter(Boolean))].slice(0, 100);
  if (ids.length === 0) return { updated: 0, restoredDuplicateIds: [] as string[] };
  const rules = await getReviewRules();
  const pinHours = Math.max(1, Math.min(720, Number(await getSetting(SETTING_KEYS.PUBLIC_PIN_HOURS)) || 24));
  const isImportant = input.status === 'important';
  const publicOverride = isImportant ? 'public' : rules[input.status];
  const now = new Date();
  const tags = JSON.stringify(parseReasonTags(input.reasonTags));
  const result = await db.$transaction(async tx => {
    const articles = await tx.article.findMany({ where: { id: { in: ids } }, select: { id: true, duplicateStatus: true } });
    const restoredDuplicateIds = isImportant
      ? articles.filter(article => article.duplicateStatus === 'duplicate').map(article => article.id)
      : [];
    await tx.article.updateMany({
      where: { id: { in: articles.map(article => article.id) } },
      data: {
        reviewStatus: input.status,
        reviewReasonTags: tags,
        reviewedAt: now,
        publicOverride,
        pinUntil: isImportant ? new Date(now.getTime() + pinHours * 60 * 60 * 1000) : null,
      },
    });
    for (const id of restoredDuplicateIds) {
      await tx.article.update({ where: { id }, data: buildAiResetData({ dedupOverride: true }) });
    }
    await refreshPublicPublications(articles.map(article => article.id), tx, { contentChanged: true });
    return { updated: articles.length, restoredDuplicateIds };
  });
  invalidatePublicArticleCache();
  await captureInboxSnapshot().catch(() => undefined);
  return result;
}

export async function listTuningSuggestions() {
  return db.tuningSuggestion.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
}

/** 根据人工反馈生成可解释建议，不直接修改评分、提示词或关键词。 */
export async function generateTuningSuggestions() {
  const rows = await db.article.findMany({
    where: { reviewedAt: { not: null }, reviewStatus: { not: 'unreviewed' } },
    select: { reviewStatus: true, reviewReasonTags: true, score: true },
    orderBy: { reviewedAt: 'desc' },
    take: 500,
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    let rawTags: unknown = [];
    try { rawTags = JSON.parse(row.reviewReasonTags || '[]'); } catch { rawTags = []; }
    const tags = parseReasonTags(rawTags);
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    if (row.reviewStatus === 'irrelevant' && row.score >= 80) counts.set('high_score_irrelevant', (counts.get('high_score_irrelevant') ?? 0) + 1);
    if (row.reviewStatus === 'important' && row.score < 60) counts.set('low_score_important', (counts.get('low_score_important') ?? 0) + 1);
  }
  const suggestions = [
    ['high_score_irrelevant', '检查高分无关文章', '存在高分但被归类为无关的文章，建议将公开最低评分上调 5 分。', { settingKey: SETTING_KEYS.PUBLIC_MIN_SCORE, delta: 5 }],
    ['low_score_important', '检查低分重要文章', '存在低分但被归类为重要的文章，建议将公开最低评分下调 5 分。', { settingKey: SETTING_KEYS.PUBLIC_MIN_SCORE, delta: -5 }],
    ['ad_misclassification', '复核软文判断', '人工反馈中出现软文误判，建议在提示词页人工复核广告规则。', { action: 'manual-review' }],
    ['wrong_brand', '复核品牌识别', '人工反馈中出现品牌错误，建议在关键词页人工复核品牌字典。', { action: 'manual-review' }],
    ['keyword_ambiguity', '收紧关键词边界', '人工反馈显示关键词存在歧义，建议补充更具体的关键词。', { action: 'manual-review' }],
  ] as const;
  const created: string[] = [];
  for (const [kind, title, detail, payload] of suggestions) {
    const count = counts.get(kind) ?? 0;
    if (count < 2) continue;
    const existing = await db.tuningSuggestion.findFirst({ where: { kind, status: 'pending' } });
    if (existing) continue;
    const row = await db.tuningSuggestion.create({ data: { kind, title, detail: `${detail}（最近样本 ${count} 条）`, payload: JSON.stringify({ count, ...payload }) } });
    created.push(row.id);
  }
  return { created: created.length };
}

export async function applyTuningSuggestion(id: string) {
  const suggestion = await db.tuningSuggestion.findUnique({ where: { id } });
  if (!suggestion || suggestion.status !== 'pending') return null;
  let payload: { settingKey?: string; delta?: number } = {};
  try { payload = JSON.parse(suggestion.payload) as typeof payload; } catch { payload = {}; }
  if (payload.settingKey && typeof payload.delta === 'number') {
    const current = Number(await getSetting(payload.settingKey));
    const next = Math.max(0, Math.min(100, (Number.isFinite(current) ? current : 70) + payload.delta));
    await updatePublicPublicationSetting(payload.settingKey, String(next));
  }
  await db.tuningSuggestion.update({ where: { id }, data: { status: 'applied', appliedAt: new Date() } });
  return { id, applied: true };
}

export async function dismissTuningSuggestion(id: string) {
  const result = await db.tuningSuggestion.updateMany({ where: { id, status: 'pending' }, data: { status: 'dismissed' } });
  return result.count > 0;
}
