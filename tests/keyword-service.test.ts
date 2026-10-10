import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from 'exceljs';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

const mocks = vi.hoisted(() => ({
  keywordFindMany: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    keyword: {
      findMany: mocks.keywordFindMany,
    },
    $queryRaw: mocks.queryRaw,
  },
}));

import {
  importKeywordsXlsx,
  KEYWORD_XLSX_MAX_BYTES,
  keywordsToXlsx,
  listKeywords,
} from '../src/lib/keyword-service';

describe('关键词命中统计', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.keywordFindMany.mockResolvedValue([
      { id: 'brand', category: '品牌', word: '奈雪' },
      { id: 'blacklist', category: '黑名单', word: '联商头条：' },
      { id: 'unused', category: '品牌', word: '未命中' },
    ]);
    mocks.queryRaw
      .mockResolvedValueOnce([{ id: 'brand', hitCount: 4n }])
      .mockResolvedValueOnce([{ id: 'blacklist', hitCount: 3n }]);
  });

  it('分别合并当前文章与黑名单拦截记录的命中数', async () => {
    await expect(listKeywords()).resolves.toEqual([
      { id: 'brand', category: '品牌', word: '奈雪', hitCount: 4 },
      { id: 'blacklist', category: '黑名单', word: '联商头条：', hitCount: 3 },
      { id: 'unused', category: '品牌', word: '未命中', hitCount: 0 },
    ]);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });

  it('关键词 XLSX 用工作表表达候选状态，不重复保存状态列', () => {
    const workbook = XLSX.read(keywordsToXlsx(
      [{ category: '品牌', word: '奈雪' }],
      [{ phrase: '新品牌', occurrences: 3, sampleTitles: ['标题一'], status: 'approved' }],
    ), { type: 'buffer' });

    expect(workbook.SheetNames).toEqual(['关键词', '候选词-已采用', '候选词-永久忽略', '候选词-待确认']);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['候选词-已采用'], { header: 1 })[0]).toEqual(['候选词', '出现次数', '示例标题']);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['候选词-已采用'], { header: 1 })[1]).toEqual(['新品牌', 3, '标题一']);
  });

  it('关键词 XLSX 拒绝重复关键词和跨工作表候选词', async () => {
    const duplicateKeywords = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      duplicateKeywords,
      XLSX.utils.aoa_to_sheet([['类型', '关键词'], ['品牌', '奈雪'], ['品牌', '奈雪']]),
      '关键词',
    );
    await expect(importKeywordsXlsx(new Uint8Array(XLSX.write(duplicateKeywords, { bookType: 'xlsx', type: 'buffer' })))).rejects.toThrow('关键词工作表存在重复项');

    const duplicateCandidates = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(duplicateCandidates, XLSX.utils.aoa_to_sheet([['类型', '关键词']]), '关键词');
    XLSX.utils.book_append_sheet(duplicateCandidates, XLSX.utils.aoa_to_sheet([['候选词', '出现次数', '示例标题'], ['新品牌', 2, '标题一']]), '候选词-已采用');
    XLSX.utils.book_append_sheet(duplicateCandidates, XLSX.utils.aoa_to_sheet([['候选词', '出现次数', '示例标题'], ['新品牌', 1, '标题二']]), '候选词-待确认');
    await expect(importKeywordsXlsx(new Uint8Array(XLSX.write(duplicateCandidates, { bookType: 'xlsx', type: 'buffer' })))).rejects.toThrow('候选词工作表存在重复状态');
  });

  it('拒绝超过压缩体积、归档文件数和解压体积上限的工作簿', async () => {
    await expect(importKeywordsXlsx(new Uint8Array(KEYWORD_XLSX_MAX_BYTES + 1)))
      .rejects.toThrow('关键词工作簿过大');

    const tooManyFiles = new JSZip();
    for (let index = 0; index < 33; index += 1) tooManyFiles.file(`entry-${index}.xml`, 'x');
    const tooManyFilesBuffer = await tooManyFiles.generateAsync({ type: 'uint8array' });
    await expect(importKeywordsXlsx(tooManyFilesBuffer))
      .rejects.toThrow('关键词工作簿包含过多文件');

    const tooLargeEntry = new JSZip();
    tooLargeEntry.file('large.xml', 'x'.repeat(8 * 1024 * 1024 + 1));
    const tooLargeEntryBuffer = await tooLargeEntry.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 1 },
    });
    await expect(importKeywordsXlsx(tooLargeEntryBuffer))
      .rejects.toThrow('关键词工作簿单个文件内容过大');

    const tooMuchUncompressed = new JSZip();
    const sevenMegabytes = 'x'.repeat(7 * 1024 * 1024);
    tooMuchUncompressed.file('first.xml', sevenMegabytes);
    tooMuchUncompressed.file('second.xml', sevenMegabytes);
    tooMuchUncompressed.file('third.xml', sevenMegabytes);
    const tooMuchUncompressedBuffer = await tooMuchUncompressed.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 1 },
    });
    await expect(importKeywordsXlsx(tooMuchUncompressedBuffer))
      .rejects.toThrow('关键词工作簿解压后内容过大');
  });

  it('拒绝超出行数、列数或工作表数量限制的工作簿', async () => {
    const tooManySheets = new Workbook();
    for (let index = 0; index < 9; index += 1) tooManySheets.addWorksheet(`sheet-${index}`);
    await expect(importKeywordsXlsx(new Uint8Array(await tooManySheets.xlsx.writeBuffer())))
      .rejects.toThrow('关键词工作簿包含过多工作表');

    const tooManyRows = new Workbook();
    tooManyRows.addWorksheet('关键词').getCell('A100001').value = 'overflow';
    await expect(importKeywordsXlsx(new Uint8Array(await tooManyRows.xlsx.writeBuffer())))
      .rejects.toThrow('关键词工作簿行数超出限制');

    const tooManyColumns = new Workbook();
    tooManyColumns.addWorksheet('关键词').getCell('Q1').value = 'overflow';
    await expect(importKeywordsXlsx(new Uint8Array(await tooManyColumns.xlsx.writeBuffer())))
      .rejects.toThrow('关键词工作簿列数超出限制');
  });
});
