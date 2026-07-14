import { db } from './db';
import { applyScorePolicy } from './score-policy';

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
