import { db } from '@/lib/db';

const REASON_TO_DEDUPTYPE: Record<string, string> = {
  'dedup:url': 'url_exact', 'dedup:content': 'content_fingerprint', 'dedup:near': 'near_duplicate', 'dedup:entity': 'near_duplicate',
};

const METHOD_TO_DEDUPTYPE: Record<string, string> = {
  url: 'url_exact',
  fingerprint: 'content_fingerprint',
  title_jaccard: 'title_similar',
  body_lcs: 'near_duplicate',
  numeric: 'near_duplicate',
  numeric_lcs: 'near_duplicate',
  keypoints_lcs: 'near_duplicate',
};

function parseSimilarity(detail: string | null): number | null {
  if (!detail) return null;
  try {
    const value = (JSON.parse(detail) as { similarity?: unknown }).similarity;
    return typeof value === 'number' && !Number.isNaN(value) ? value : null;
  } catch { return null; }
}

function parseMethodKey(detail: string | null): string {
  if (!detail) return 'near_duplicate';
  try {
    const value = (JSON.parse(detail) as { methodKey?: unknown }).methodKey;
    if (typeof value !== 'string' || value.length === 0) return 'near_duplicate';
    return METHOD_TO_DEDUPTYPE[value] || value;
  } catch {
    return 'near_duplicate';
  }
}

export async function getDedupStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dedupWhere = { reason: { startsWith: 'dedup:' } };
  const [todayDiscarded, allTimeDiscarded, todayDiscardedRows, todayMarked, allTimeMarked, todayMarkedRows] = await Promise.all([
    db.discardedItem.count({ where: { ...dedupWhere, createdAt: { gte: todayStart } } }),
    db.discardedItem.count({ where: dedupWhere }),
    db.discardedItem.findMany({ where: { ...dedupWhere, createdAt: { gte: todayStart } }, select: { reason: true, detail: true } }),
    db.article.count({ where: { aiStatus: 'skipped', dedupDetail: { not: null }, createdAt: { gte: todayStart } } }),
    db.article.count({ where: { aiStatus: 'skipped', dedupDetail: { not: null } } }),
    db.article.findMany({ where: { aiStatus: 'skipped', dedupDetail: { not: null }, createdAt: { gte: todayStart } }, select: { dedupDetail: true } }),
  ]);
  const byType: Record<string, { count: number; avgSimilarity: number }> = {};
  let totalSimilarity = 0;
  let totalCounted = 0;
  const todayRows = [
    ...todayDiscardedRows.map((row) => ({ type: REASON_TO_DEDUPTYPE[row.reason] || row.reason, detail: row.detail })),
    ...todayMarkedRows.map((row) => ({ type: parseMethodKey(row.dedupDetail), detail: row.dedupDetail })),
  ];
  for (const row of todayRows) {
    const type = row.type;
    const similarity = parseSimilarity(row.detail);
    if (!byType[type]) byType[type] = { count: 0, avgSimilarity: 0 };
    byType[type].count++;
    if (similarity !== null) { totalSimilarity += similarity; totalCounted++; }
  }
  for (const type of Object.keys(byType)) {
    const values = todayRows.map((row) => row.type === type ? parseSimilarity(row.detail) : null)
      .filter((value): value is number => value !== null);
    byType[type].avgSimilarity = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 100) / 100 : 0;
  }
  return {
    todayCount: todayDiscarded + todayMarked,
    allTimeTotal: allTimeDiscarded + allTimeMarked,
    avgSimilarity: totalCounted ? Math.round(totalSimilarity / totalCounted * 100) / 100 : 0,
    byType,
  };
}
