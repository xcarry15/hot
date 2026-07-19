import { db } from '@/lib/db';
import { retryDiscardedItem } from '@/lib/discarded-retry-service';
import { invalidateKeywordCache } from '@/lib/filter';

const MAX_CANDIDATE_RESTORE = 50;
const MAX_PHRASES_PER_TITLE = 12;
const EXTRACTED_KEYWORD_CATEGORY = '提取';

const STOP_WORDS = new Set(['我们', '公司', '行业', '市场', '相关', '表示', '发布', '消息', '最新', '多个', '进行', '以及']);
const titleSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

function parseSampleTitles(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function extractPhrases(title: string): string[] {
  const phrases = [...titleSegmenter.segment(title)]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment.trim().toLowerCase())
    .filter((phrase) => {
      const length = Array.from(phrase).length;
      return length >= 2
        && length <= 8
        && !STOP_WORDS.has(phrase)
        && !/\d/.test(phrase)
        && /[\p{Script=Han}A-Za-z]/u.test(phrase);
    });
  const ordered = [...new Set(phrases)].sort((left, right) => (
    Array.from(right).length - Array.from(left).length || left.localeCompare(right)
  ));
  const selected: string[] = [];
  for (const phrase of ordered) {
    // 同一标题优先保留完整长词，去掉已被长词覆盖的短片段。
    if (selected.some((existing) => existing.includes(phrase))) continue;
    selected.push(phrase);
    if (selected.length >= MAX_PHRASES_PER_TITLE) break;
  }
  return selected;
}

/** 从未命中标题提取本地候选词；只记录候选，不改变正式关键词。 */
export async function recordKeywordCandidates(title: string): Promise<void> {
  const phrases = extractPhrases(title);
  if (phrases.length === 0) return;

  const existing = await db.keywordCandidate.findMany({
    where: { phrase: { in: phrases } },
  });
  const existingByPhrase = new Map(existing.map((candidate) => [candidate.phrase, candidate]));
  const writes = [];
  for (const phrase of phrases) {
    const current = existingByPhrase.get(phrase);
    const samples = current ? parseSampleTitles(current.sampleTitles) : [];
    if (!samples.includes(title) && samples.length < 5) samples.push(title);
    writes.push(db.keywordCandidate.upsert({
      where: { phrase },
      update: {
        occurrences: { increment: 1 },
        sampleTitles: JSON.stringify(samples),
        // 已采用和永久忽略都保持终态，后续相同标题不能把候选重新激活。
        status: current?.status ?? 'pending',
      },
      create: { phrase, occurrences: 1, sampleTitles: JSON.stringify([title]) },
    }));
  }
  await db.$transaction(writes);
}

export async function listKeywordCandidates() {
  const discarded = await db.discardedItem.findMany({
    where: { reason: 'filter:keyword' },
    select: { id: true, title: true, sourceId: true },
  });
  if (discarded.length > 0 && await db.keywordCandidate.count() === 0) {
    for (const item of discarded) await recordKeywordCandidates(item.title);
  }
  const rows = await db.keywordCandidate.findMany({
    where: { status: 'pending', occurrences: { gte: 2 } },
    orderBy: [{ updatedAt: 'desc' }],
  });
  return rows.map((row) => {
    const matches = discarded.filter((item) => item.title.toLocaleLowerCase().includes(row.phrase.toLocaleLowerCase()));
    return {
      ...row,
      sampleTitles: [...new Set([...parseSampleTitles(row.sampleTitles), ...matches.slice(0, 5).map((item) => item.title)])].slice(0, 5),
      sourceCount: new Set(matches.map((item) => item.sourceId)).size,
      recallCount: matches.length,
    };
  }).sort((left, right) => (
    right.occurrences - left.occurrences
    || right.sourceCount - left.sourceCount
    || right.updatedAt.getTime() - left.updatedAt.getTime()
  )).slice(0, 100);
}

export async function updateKeywordCandidate(id: string, action: 'approve' | 'dismiss') {
  const candidate = await db.keywordCandidate.findUnique({ where: { id } });
  if (!candidate) return null;
  if (action === 'approve') {
    await db.$transaction([
      db.keyword.upsert({
        where: { category_word: { category: EXTRACTED_KEYWORD_CATEGORY, word: candidate.phrase } },
        update: {},
        create: { category: EXTRACTED_KEYWORD_CATEGORY, word: candidate.phrase },
      }),
      db.keywordCandidate.update({ where: { id }, data: { status: 'approved' } }),
    ]);
    invalidateKeywordCache();
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

/** 清空旧候选，并从现有关键词未命中记录重新生成。 */
export async function rebuildKeywordCandidatesFromDiscardedItems(): Promise<{ titles: number; candidates: number }> {
  const discarded = await db.discardedItem.findMany({
    where: { reason: 'filter:keyword' },
    select: { title: true },
    orderBy: { createdAt: 'asc' },
  });
  await db.keywordCandidate.deleteMany({});
  for (const item of discarded) await recordKeywordCandidates(item.title);
  return { titles: discarded.length, candidates: await db.keywordCandidate.count() };
}
