import { db } from '@/lib/db';
import { invalidateKeywordCache } from '@/lib/filter';
import * as XLSX from 'xlsx';
import {
  importKeywordCandidate,
  type ImportedKeywordCandidate,
  type KeywordCandidateExportRow,
} from '@/lib/keyword-candidate-service';

const DEFAULT_CATEGORY = 'default';

export async function listKeywords() {
  return db.keyword.findMany({ orderBy: [{ category: 'asc' }, { word: 'asc' }] });
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
        candidate.status,
      ]);
    const sheet = XLSX.utils.aoa_to_sheet([['候选词', '出现次数', '示例标题', '状态'], ...rows]);
    sheet['!cols'] = [{ wch: 28 }, { wch: 12 }, { wch: 64 }, { wch: 12 }];
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
  const keywordWrites = keywordRows.flatMap((row) => {
    const category = cellText(row, '类型') || DEFAULT_CATEGORY;
    const word = cellText(row, '关键词');
    return word ? [db.keyword.upsert({
      where: { category_word: { category, word } },
      create: { category, word },
      update: {},
    })] : [];
  });
  await db.$transaction(keywordWrites);

  let importedCandidates = 0;
  let skippedCandidates = 0;
  let restored = 0;
  for (const { name, status } of CANDIDATE_SHEETS) {
    for (const row of sheetRows<Record<string, unknown>>(workbook, name)) {
      const phrase = cellText(row, '候选词');
      if (!phrase) {
        skippedCandidates++;
        continue;
      }
      const result = await importKeywordCandidate({
        phrase,
        occurrences: Number(row['出现次数']),
        sampleTitles: sampleTitlesFromCell(cellText(row, '示例标题')),
        status,
      });
      if (!result.imported) skippedCandidates++;
      else {
        importedCandidates++;
        restored += result.restored;
      }
    }
  }

  invalidateKeywordCache();
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
  invalidateKeywordCache();
  return { imported, skipped };
}

export async function addKeyword(word: string) {
  const keyword = await db.keyword.create({ data: { category: DEFAULT_CATEGORY, word } });
  invalidateKeywordCache();
  return keyword;
}

export async function clearKeywords() {
  const result = await db.keyword.deleteMany({});
  invalidateKeywordCache();
  return result.count;
}

export async function deleteKeyword(id: string) {
  await db.keyword.delete({ where: { id } });
  invalidateKeywordCache();
}
