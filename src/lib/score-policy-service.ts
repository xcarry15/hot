import { db } from './db';
import { applyScorePolicy } from './score-policy';
import { getWebhookConfigs } from './settings';
import { parsePushMode } from '@/contracts/push';
import { pushableWhere } from '@/lib/push/policy';

export async function previewScorePolicy(weightEvent: number, weightContent: number, keywordBonus: number) {
  const articles = await db.article.findMany({
    where: { aiStatus: 'done', eventScore: { not: null }, contentScore: { not: null } },
    select: { id: true, title: true, score: true, eventScore: true, contentScore: true, adProbability: true, isAd: true, keywordMatched: true },
    orderBy: { createdAt: 'desc' },
  });
  const changes = articles.map(article => {
    const result = applyScorePolicy(
      article.eventScore!, article.contentScore!, article.adProbability ?? (article.isAd ? 100 : 0),
      article.isAd, weightEvent, weightContent,
      article.keywordMatched, keywordBonus,
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

export async function previewPublicPublication(minScore: number, minRelevance: number, hideAds: boolean) {
  const representativeBase = {
    aiStatus: 'done' as const,
    clusterStatus: 'clustered',
    source: { publicEnabled: true, deletedAt: null },
  } as const;
  const eventBase = {
    status: 'active' as const,
    clusterReviewStatus: 'confirmed' as const,
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
            { publicOverride: 'auto', score: { gte: minScore }, relevance: { gte: minRelevance }, ...(hideAds ? { isAd: false } : {}) },
          ],
        },
      },
    },
  });
  const candidates = await db.event.count({
    where: { ...eventBase, representativeArticle: { is: representativeBase } },
  });
  return { candidates, eligible, wouldPublish: eligible, wouldHide: Math.max(0, candidates - eligible), minScore, minRelevance, hideAds };
}

export async function previewPushDelivery(minScore: number, minRelevance: number, pushMode: string) {
  // 预览必须复用真实推送队列的统一门禁；否则“预计推送数”会和实际执行结果漂移。
  const pushable = await db.event.count({
    where: pushableWhere({
      pushMode: parsePushMode(pushMode),
      minScore,
      minRelevance,
    }),
  });
  const webhookCount = (await getWebhookConfigs()).filter((config) => config.enabled && config.url.trim()).length;
  return { pushMode, pushable, webhookCount, willPush: pushMode !== 'off' && webhookCount > 0 ? pushable : 0 };
}
