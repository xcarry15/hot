import { db } from './db';
import { applyScorePolicy } from './score-policy';
import { SETTING_KEYS } from './settings-catalog';

export async function previewScorePolicy(weightEvent: number, weightContent: number) {
  const articles = await db.article.findMany({
    where: { aiStatus: 'done', eventScore: { not: null }, contentScore: { not: null } },
    select: { id: true, title: true, score: true, eventScore: true, contentScore: true, adProbability: true, isAd: true },
    orderBy: { createdAt: 'desc' },
  });
  const changes = articles.map(article => {
    const result = applyScorePolicy(
      article.eventScore!, article.contentScore!, article.adProbability ?? (article.isAd ? 100 : 0),
      article.isAd, weightEvent, weightContent,
    );
    return { id: article.id, title: article.title, before: article.score, after: result.finalScore, delta: result.finalScore - article.score };
  });
  return {
    total: changes.length,
    changed: changes.filter(x => x.delta !== 0).length,
    increased: changes.filter(x => x.delta > 0).length,
    decreased: changes.filter(x => x.delta < 0).length,
    samples: changes.filter(x => x.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 10),
  };
}

export async function previewPublicPublication(minScore: number, hideAds: boolean) {
  const representativeBase = {
    aiStatus: 'done' as const,
    clusterStatus: 'clustered',
    source: { publicEnabled: true, deletedAt: null },
  } as const;
  const eventBase = {
    status: 'active' as const,
    representativeArticleId: { not: null },
  } as const;
  const eligible = await db.event.count({
    where: {
      ...eventBase,
      representativeArticle: {
        is: {
          ...representativeBase,
          OR: [
            { publicOverride: 'public' },
            { publicOverride: 'auto', score: { gte: minScore }, ...(hideAds ? { isAd: false } : {}) },
          ],
        },
      },
    },
  });
  const candidates = await db.event.count({
    where: { ...eventBase, representativeArticle: { is: representativeBase } },
  });
  return { candidates, eligible, wouldPublish: eligible, wouldHide: Math.max(0, candidates - eligible), minScore, hideAds };
}

export async function previewPushDelivery(minScore: number, minRelevance: number, pushMode: string) {
  const pushable = await db.event.count({
    where: {
      pushedAt: null,
      status: 'active',
      representativeArticle: { is: { aiStatus: 'done', clusterStatus: 'clustered', score: { gte: minScore }, relevance: { gte: minRelevance } } },
      OR: [{ nextPushRetryAt: null }, { nextPushRetryAt: { lte: new Date() } }],
    },
  });
  const webhooks = await db.setting.findUnique({ where: { key: SETTING_KEYS.FEISHU_WEBHOOK_URL }, select: { value: true } });
  let webhookCount = 0;
  try {
    const parsed = JSON.parse(webhooks?.value ?? '[]') as unknown;
    webhookCount = Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object' && (item as { enabled?: unknown }).enabled === true && typeof (item as { url?: unknown }).url === 'string' && (item as { url: string }).url.trim()).length : 0;
  } catch {
    webhookCount = 0;
  }
  return { pushMode, pushable, webhookCount, willPush: pushMode !== 'off' && webhookCount > 0 ? pushable : 0 };
}
