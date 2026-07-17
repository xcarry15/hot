import { db } from '@/lib/db';
import { retryDiscardedItem } from '@/lib/discarded-retry-service';

const MAX_CANDIDATE_RESTORE = 50;

const STOP_WORDS = new Set(['我们', '公司', '行业', '市场', '相关', '表示', '发布', '消息', '最新', '多个', '进行', '以及']);

function parseSampleTitles(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function extractPhrases(title: string): string[] {
  const normalized = title.replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, ' ').trim();
  const chunks = normalized.split(/\s+/).filter(Boolean);
  const phrases = new Set<string>();

  for (const chunk of chunks) {
    if (/^[A-Za-z0-9]+$/.test(chunk)) {
      if (chunk.length >= 2) phrases.add(chunk.toLowerCase());
      continue;
    }
    const chars = Array.from(chunk);
    for (let length = 2; length <= Math.min(6, chars.length); length += 1) {
      for (let start = 0; start + length <= chars.length; start += 1) {
        const phrase = chars.slice(start, start + length).join('');
        if (!STOP_WORDS.has(phrase)) phrases.add(phrase);
      }
    }
  }

  return [...phrases].slice(0, 24);
}

/** 从未命中标题提取本地候选词；只记录候选，不改变正式关键词。 */
export async function recordKeywordCandidates(title: string): Promise<void> {
  const phrases = extractPhrases(title);
  if (phrases.length === 0) return;

  for (const phrase of phrases) {
    const current = await db.keywordCandidate.findUnique({ where: { phrase } });
    const samples = current ? parseSampleTitles(current.sampleTitles) : [];
    if (!samples.includes(title) && samples.length < 5) samples.push(title);
    await db.keywordCandidate.upsert({
      where: { phrase },
      update: {
        occurrences: { increment: 1 },
        sampleTitles: JSON.stringify(samples),
        // 已采用和永久忽略都保持终态，后续相同标题不能把候选重新激活。
        status: current?.status ?? 'pending',
      },
      create: { phrase, occurrences: 1, sampleTitles: JSON.stringify([title]) },
    });
  }
}

export async function listKeywordCandidates() {
  const rows = await db.keywordCandidate.findMany({
    where: { status: 'pending', occurrences: { gte: 2 } },
    orderBy: [{ occurrences: 'desc' }, { updatedAt: 'desc' }],
    take: 100,
  });
  const discarded = await db.discardedItem.findMany({
    where: { reason: 'filter:keyword' },
    select: { id: true, title: true, sourceId: true },
  });
  return rows.map((row) => {
    const matches = discarded.filter((item) => item.title.toLocaleLowerCase().includes(row.phrase.toLocaleLowerCase()));
    return {
      ...row,
      sampleTitles: [...new Set([...parseSampleTitles(row.sampleTitles), ...matches.slice(0, 5).map((item) => item.title)])].slice(0, 5),
      sourceCount: new Set(matches.map((item) => item.sourceId)).size,
      recallCount: matches.length,
    };
  });
}

export async function updateKeywordCandidate(id: string, action: 'approve' | 'dismiss') {
  const candidate = await db.keywordCandidate.findUnique({ where: { id } });
  if (!candidate) return null;
  if (action === 'approve') {
    await db.$transaction([
      db.keyword.upsert({
        where: { category_word: { category: '正面', word: candidate.phrase } },
        update: {},
        create: { category: '正面', word: candidate.phrase },
      }),
      db.keywordCandidate.update({ where: { id }, data: { status: 'approved' } }),
    ]);
    const discarded = await db.discardedItem.findMany({
      where: { reason: 'filter:keyword', title: { contains: candidate.phrase } },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_CANDIDATE_RESTORE,
    });
    const articleIds: string[] = [];
    let restored = 0;
    for (const item of discarded) {
      const result = await retryDiscardedItem(item.id);
      if (result.kind === 'created' || result.kind === 'existing') {
        restored += 1;
        articleIds.push(result.articleId);
      }
    }
    return { id, action, restored, articleIds, restoreLimit: MAX_CANDIDATE_RESTORE };
  } else {
    await db.keywordCandidate.update({ where: { id }, data: { status: 'dismissed' } });
  }
  return { id, action, restored: 0, articleIds: [] as string[], restoreLimit: MAX_CANDIDATE_RESTORE };
}
