import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { importKeywordsXlsx, keywordsToXlsx, listKeywords } from '../src/lib/keyword-service';

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
    expect(importKeywordsXlsx(new Uint8Array(XLSX.write(duplicateKeywords, { bookType: 'xlsx', type: 'buffer' })))).rejects.toThrow('关键词工作表存在重复项');

    const duplicateCandidates = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(duplicateCandidates, XLSX.utils.aoa_to_sheet([['类型', '关键词']]), '关键词');
    XLSX.utils.book_append_sheet(duplicateCandidates, XLSX.utils.aoa_to_sheet([['候选词', '出现次数', '示例标题'], ['新品牌', 2, '标题一']]), '候选词-已采用');
    XLSX.utils.book_append_sheet(duplicateCandidates, XLSX.utils.aoa_to_sheet([['候选词', '出现次数', '示例标题'], ['新品牌', 1, '标题二']]), '候选词-待确认');
    expect(importKeywordsXlsx(new Uint8Array(XLSX.write(duplicateCandidates, { bookType: 'xlsx', type: 'buffer' })))).rejects.toThrow('候选词工作表存在重复状态');
  });
});
