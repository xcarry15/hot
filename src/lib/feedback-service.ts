import { db } from '@/lib/db';
import { parseArticleAiSnapshot, parseManualOverrides, type ManualOverrideField } from '@/lib/article-calibration';

export async function listTuningSuggestions() {
  return db.tuningSuggestion.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
}

/** 根据人工字段修正生成可解释建议，不直接修改评分、提示词或关键词。 */
export async function generateTuningSuggestions() {
  const rows = await db.article.findMany({
    where: {
      manualCorrectedAt: { not: null },
      manualOverrides: { not: '[]' },
    },
    select: {
      aiSnapshot: true,
      manualOverrides: true,
      relevance: true,
      eventScore: true,
      contentScore: true,
      adProbability: true,
      isAd: true,
      brand: true,
      category: true,
      summary: true,
      eventSubjects: true,
      eventAction: true,
      eventObject: true,
      keyPoints: true,
    },
    orderBy: { manualCorrectedAt: 'desc' },
    take: 500,
  });
  const counts = new Map<string, number>();
  const deltas = new Map<string, number>();
  const addCorrection = (kind: string, delta = 0) => {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    deltas.set(kind, (deltas.get(kind) ?? 0) + delta);
  };
  for (const row of rows) {
    const snapshot = parseArticleAiSnapshot(row.aiSnapshot);
    for (const field of parseManualOverrides(row.manualOverrides)) {
      const aiValue = snapshot[field];
      const current = row[field as ManualOverrideField] as unknown;
      if (typeof aiValue === 'number' && typeof current === 'number' && aiValue !== current) {
        addCorrection(`${field}_adjusted`, current - aiValue);
      } else if (typeof aiValue === 'boolean' && typeof current === 'boolean' && aiValue !== current) {
        addCorrection(`${field}_adjusted`);
      } else if (typeof aiValue === 'string' && typeof current === 'string' && aiValue !== current) {
        addCorrection(`${field}_adjusted`);
      }
    }
  }
  const suggestions = [
    ['eventScore_adjusted', '复核事件分规则', '人工多次调整事件分，建议检查事件影响力评分提示词与示例。'],
    ['contentScore_adjusted', '复核内容分规则', '人工多次调整内容分，建议检查内容质量评分提示词与示例。'],
    ['adProbability_adjusted', '复核广告概率规则', '人工多次调整广告概率，建议检查软文识别规则与提示词。'],
    ['isAd_adjusted', '复核软文判断', '人工多次推翻软文判断，建议检查软文识别规则与提示词。'],
    ['relevance_adjusted', '复核相关度规则', '人工多次调整相关度，建议检查行业相关性边界与示例。'],
    ['brand_adjusted', '复核品牌识别', '人工多次修正品牌，建议检查品牌词典和品牌识别提示词。'],
    ['category_adjusted', '复核分类规则', '人工多次修正分类，建议检查分类边界与提示词示例。'],
    ['eventSubjects_adjusted', '复核事件主体提取', '人工多次修正事件主体，建议检查事件身份提示词中的主体命名规则。'],
    ['eventAction_adjusted', '复核事件行为提取', '人工多次修正事件行为，建议检查行为及事件阶段的提取规则。'],
    ['eventObject_adjusted', '复核具体事项提取', '人工多次修正具体事项，建议检查区分事件所需的对象与限定信息。'],
  ] as const;
  const created: string[] = [];
  for (const [kind, title, detail] of suggestions) {
    const count = counts.get(kind) ?? 0;
    if (count < 2) continue;
    const existing = await db.tuningSuggestion.findFirst({ where: { kind, status: 'pending' } });
    if (existing) continue;
    const delta = deltas.get(kind);
    const deltaText = typeof delta === 'number' && delta !== 0
      ? `，平均调整 ${Math.round(delta / count) > 0 ? '+' : ''}${Math.round(delta / count)} 分`
      : '';
    const row = await db.tuningSuggestion.create({ data: { kind, title, detail: `${detail}（最近样本 ${count} 条${deltaText}）`, payload: JSON.stringify({ count, delta }) } });
    created.push(row.id);
  }
  return { created: created.length };
}

export async function applyTuningSuggestion(id: string) {
  const suggestion = await db.tuningSuggestion.findUnique({ where: { id } });
  if (!suggestion || suggestion.status !== 'pending') return null;
  await db.tuningSuggestion.update({ where: { id }, data: { status: 'applied', appliedAt: new Date() } });
  return { id, applied: true };
}

export async function dismissTuningSuggestion(id: string) {
  const result = await db.tuningSuggestion.updateMany({ where: { id, status: 'pending' }, data: { status: 'dismissed' } });
  return result.count > 0;
}
