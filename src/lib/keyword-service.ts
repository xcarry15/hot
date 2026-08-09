import { db } from '@/lib/db';
import { createCache } from '@/lib/cache';
import { invalidateKeywordCache } from '@/lib/filter';
import { invalidateKeywordFilterDiscards } from '@/lib/keyword-filter-state';
import * as XLSX from 'xlsx';
import {
  importKeywordCandidate,
  type ImportedKeywordCandidate,
  type KeywordCandidateExportRow,
} from '@/lib/keyword-candidate-service';
import { KEYWORD_BLACKLIST_CATEGORY, KEYWORD_DEFAULT_CATEGORY } from '@/contracts/keywords';

const DEFAULT_CATEGORY = KEYWORD_DEFAULT_CATEGORY;
const KEYWORD_HIT_COUNT_WINDOW_DAYS = 90;
const keywordHitCountCache = createCache<Map<string, number>>(15_000);

export function invalidateKeywordRuntimeCaches(): void {
  keywordHitCountCache.invalidate();
  invalidateKeywordCache();
}

async function loadKeywordHitCounts(rows: Array<{ id: string; word: string }>) {
  if (rows.length === 0) return new Map<string, number>();
  const cached = keywordHitCountCache.get();
  if (cached) return cached;
  // SQLite 的 DateTime 列存储为毫秒时间戳；使用数值避免和 ISO 字符串比较时全部落空。
  const cutoff = Date.now() - KEYWORD_HIT_COUNT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  // keywordMatched 只表示文章在当时命中过任一白名单词，并不记录具体命中的词。
  // 新数据在 process 阶段写入 keyword_hits；设置页直接按命中明细计数。
  // 黑名单文章不会进入 Article，仍从明确记录 matchedKeyword 的拦截审计统计。
  const [articleHitRows, blacklistHitRows] = await Promise.all([
    db.$queryRaw<Array<{ id: string; hitCount: number | bigint }>>`
    SELECT k.id AS id, COUNT(h.articleId) AS hitCount
    FROM keywords AS k
    LEFT JOIN keyword_hits AS h
      ON h.keywordId = k.id
      AND h.createdAt >= ${cutoff}
    LEFT JOIN articles AS a
      ON a.id = h.articleId
    LEFT JOIN sources AS s
      ON s.id = a.sourceId
      AND s.deletedAt IS NULL
    WHERE k.word <> ''
      AND k.category <> ${KEYWORD_BLACKLIST_CATEGORY}
      AND s.id IS NOT NULL
    GROUP BY k.id
  `,
    db.$queryRaw<Array<{ id: string; hitCount: number | bigint }>>`
    SELECT k.id AS id, COUNT(d.id) AS hitCount
    FROM keywords AS k
    LEFT JOIN discarded_items AS d
      ON d.reason = 'filter:blacklist'
      AND COALESCE(d.publishedAt, d.createdAt) >= ${cutoff}
      AND CASE
        WHEN json_valid(d.detail) THEN json_extract(d.detail, '$.matchedKeyword')
        ELSE NULL
      END = k.word
    LEFT JOIN sources AS s
      ON s.id = d.sourceId
      AND s.deletedAt IS NULL
    WHERE k.word <> ''
      AND k.category = ${KEYWORD_BLACKLIST_CATEGORY}
      AND s.id IS NOT NULL
    GROUP BY k.id
  `,
  ]);
  const result = new Map<string, number>();
  for (const row of [...articleHitRows, ...blacklistHitRows]) {
    result.set(row.id, (result.get(row.id) ?? 0) + Number(row.hitCount));
  }
  keywordHitCountCache.set(result);
  return result;
}

export async function listKeywords(options: { includeHitCount?: boolean } = {}) {
  const rows = await db.keyword.findMany({ orderBy: [{ category: 'asc' }, { word: 'asc' }] });
  if (options.includeHitCount === false) return rows;
  const hitCounts = await loadKeywordHitCounts(rows);
  return rows.map(row => ({ ...row, hitCount: hitCounts.get(row.id) ?? 0 }));
}

export async function listKeywordCategories() {
  const rows = await db.keyword.findMany({
    select: { category: true },
    distinct: ['category'],
    orderBy: { category: 'asc' },
  });
  return rows.map(row => row.category);
}

const KEYWORD_SHEET = '关键词';
const CANDIDATE_SHEETS: Array<{ name: string; status: ImportedKeywordCandidate['status'] }> = [
  { name: '候选词-已采用', status: 'approved' },
  { name: '候选词-永久忽略', status: 'dismissed' },
  { name: '候选词-待确认', status: 'pending' },
];

function sheetRows<T>(workbook: XLSX.WorkBook, name: string): T[] {
  const sheet = workbook.Sheets[name];
  return sheet ? XLSX.utils.sheet_to_json<T>(sheet, { defval: '' }) : [];
}

function cellText(row: Record<string, unknown>, key: string): string {
  return String(row[key] ?? '').trim();
}

function sampleTitlesFromCell(value: string): string[] {
  return value.split(/\r?\n/).map((title) => title.trim()).filter(Boolean).slice(0, 5);
}

export function keywordsToXlsx(
  keywords: Array<{ category: string; word: string }>,
  candidates: KeywordCandidateExportRow[],
): Buffer {
  const workbook = XLSX.utils.book_new();
  const keywordRows = [['类型', '关键词'], ...keywords.map((keyword) => [keyword.category, keyword.word])];
  const keywordSheet = XLSX.utils.aoa_to_sheet(keywordRows);
  keywordSheet['!cols'] = [{ wch: 16 }, { wch: 32 }];
  XLSX.utils.book_append_sheet(workbook, keywordSheet, KEYWORD_SHEET);

  for (const { name, status } of CANDIDATE_SHEETS) {
    const rows = candidates
      .filter((candidate) => candidate.status === status)
      .map((candidate) => [
        candidate.phrase,
        candidate.occurrences,
        candidate.sampleTitles.join('\n'),
      ]);
    const sheet = XLSX.utils.aoa_to_sheet([['候选词', '出现次数', '示例标题'], ...rows]);
    sheet['!cols'] = [{ wch: 28 }, { wch: 12 }, { wch: 64 }];
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }

  return XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }) as Buffer;
}

export async function importKeywordsXlsx(input: Uint8Array) {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(input, { type: 'array' });
  } catch {
    throw new Error('文件不是有效的关键词 XLSX 工作簿');
  }

  const keywordRows = sheetRows<Record<string, unknown>>(workbook, KEYWORD_SHEET);
  const keywordEntries = keywordRows.flatMap((row) => {
    const category = cellText(row, '类型') || DEFAULT_CATEGORY;
    const word = cellText(row, '关键词');
    return word ? [{ category, word }] : [];
  });

  const keywordKeys = new Set<string>();
  for (const keyword of keywordEntries) {
    const key = `${keyword.category}\u0000${keyword.word}`;
    if (keywordKeys.has(key)) throw new Error(`关键词工作表存在重复项：${keyword.category} / ${keyword.word}`);
    keywordKeys.add(key);
  }

  const candidateEntries: ImportedKeywordCandidate[] = [];
  const candidatePhrases = new Set<string>();
  let skippedCandidates = 0;
  for (const { name, status } of CANDIDATE_SHEETS) {
    for (const row of sheetRows<Record<string, unknown>>(workbook, name)) {
      const phrase = cellText(row, '候选词');
      if (!phrase) {
        skippedCandidates++;
        continue;
      }
      if (candidatePhrases.has(phrase)) throw new Error(`候选词工作表存在重复状态：${phrase}`);
      candidatePhrases.add(phrase);
      candidateEntries.push({
        phrase,
        occurrences: Number(row['出现次数']),
        sampleTitles: sampleTitlesFromCell(cellText(row, '示例标题')),
        status,
      });
    }
  }

  const keywordWrites = keywordEntries.map(({ category, word }) => db.keyword.upsert({
    where: { category_word: { category, word } },
    create: { category, word },
    update: {},
  }));
  await db.$transaction(keywordWrites);

  let importedCandidates = 0;
  let restored = 0;
  for (const candidate of candidateEntries) {
    const result = await importKeywordCandidate(candidate);
    if (!result.imported) skippedCandidates++;
    else {
      importedCandidates++;
      restored += result.restored;
    }
  }

  invalidateKeywordRuntimeCaches();
  await invalidateKeywordFilterDiscards();
  return { imported: keywordWrites.length, skipped: keywordRows.length - keywordWrites.length, importedCandidates, skippedCandidates, restored };
}

export async function addKeywordsText(text: string, category?: string) {
  const lines = text.split(/\r?\n/).map((word) => word.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const actualCategory = category?.trim() || DEFAULT_CATEGORY;
  let imported = 0;
  let skipped = 0;
  try {
    const result = await db.keyword.createMany({ data: lines.map((word) => ({ category: actualCategory, word })) });
    imported = result.count;
    skipped = lines.length - imported;
  } catch {
    for (const word of lines) {
      try {
        await db.keyword.upsert({ where: { category_word: { category: actualCategory, word } }, create: { category: actualCategory, word }, update: {} });
        imported++;
      } catch { skipped++; }
    }
  }
  invalidateKeywordRuntimeCaches();
  await invalidateKeywordFilterDiscards();
  return { imported, skipped };
}

export async function addKeyword(word: string, category?: string) {
  const keyword = await db.keyword.create({ data: { category: category?.trim() || DEFAULT_CATEGORY, word } });
  invalidateKeywordRuntimeCaches();
  await invalidateKeywordFilterDiscards();
  return keyword;
}

export async function clearKeywords() {
  const result = await db.keyword.deleteMany({});
  invalidateKeywordRuntimeCaches();
  await invalidateKeywordFilterDiscards();
  return result.count;
}

export async function deleteKeyword(id: string) {
  await db.keyword.delete({ where: { id } });
  invalidateKeywordRuntimeCaches();
  await invalidateKeywordFilterDiscards();
}
