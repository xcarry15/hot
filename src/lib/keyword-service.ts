import { db } from '@/lib/db';
import { invalidateKeywordCache } from '@/lib/filter';

const DEFAULT_CATEGORY = 'default';

export async function listKeywords() {
  return db.keyword.findMany({ orderBy: [{ category: 'asc' }, { word: 'asc' }] });
}

export function keywordsToCsv(keywords: Array<{ category: string; word: string }>): string {
  const header = '\uFEFF类型,关键词';
  const rows = keywords.map((keyword) => `${keyword.category},${keyword.word.includes(',') ? `"${keyword.word}"` : keyword.word}`);
  return [header, ...rows].join('\r\n');
}

function parseCsvLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts;
}

export async function importKeywordsCsv(csv: string) {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim());
  const startAt = lines.length > 0 && /类型|category/i.test(lines[0]) ? 1 : 0;
  let imported = 0;
  let skipped = 0;
  for (let i = startAt; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i].trim());
    if (parts.length < 2) { skipped++; continue; }
    const category = parts[0].trim() || DEFAULT_CATEGORY;
    const word = parts[1].trim();
    if (!word) { skipped++; continue; }
    try {
      await db.keyword.upsert({ where: { category_word: { category, word } }, create: { category, word }, update: {} });
      imported++;
    } catch { skipped++; }
  }
  invalidateKeywordCache();
  return { imported, skipped };
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
