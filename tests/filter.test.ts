/**
 * matchKeyword 纯函数测试
 *
 * 覆盖：
 * - 基本命中 / 大小写无关 / 多关键词命中其一 / 不命中
 * - DB 空 → 不过滤（返 true）
 * - 子串匹配的边界（空白、空文本）
 * - 关键词缓存命中 + invalidateKeywordCache 强制重读
 *
 * 背景：collect 阶段已经把关键字匹配搬到 process 阶段（用全文），
 * 但 matchKeyword 本身没改 — 它的语义必须被锁死，否则阶段重构会引入回归。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocksHoisted = vi.hoisted(() => ({
  keywordFindMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    keyword: {
      findMany: mocksHoisted.keywordFindMany,
    },
  },
}));

import { matchKeyword, invalidateKeywordCache } from '../src/lib/filter';

beforeEach(() => {
  mocksHoisted.keywordFindMany.mockReset();
  invalidateKeywordCache();
});

describe('matchKeyword 基本命中', () => {
  it('关键词命中正文 → true', async () => {
    mocksHoisted.keywordFindMany.mockResolvedValue([{ word: '奈雪' }]);
    expect(await matchKeyword('奈雪发布2026战略')).toBe(true);
  });

  it('关键词大小写无关（keyword小写 + text大写）→ true', async () => {
    mocksHoisted.keywordFindMany.mockResolvedValue([{ word: 'naixue' }]);
    expect(await matchKeyword('NAIXUE 2026')).toBe(true);
  });

  it('多个关键词中任一命中 → true', async () => {
    mocksHoisted.keywordFindMany.mockResolvedValue([
      { word: '奈雪' },
      { word: '瑞幸' },
      { word: '喜茶' },
    ]);
    expect(await matchKeyword('瑞幸与库迪竞争激烈')).toBe(true);
  });

  it('多个关键词全部不命中 → false', async () => {
    mocksHoisted.keywordFindMany.mockResolvedValue([
      { word: '奈雪' },
      { word: '瑞幸' },
      { word: '喜茶' },
    ]);
    expect(await matchKeyword('星巴克与百胜')).toBe(false);
  });

  it('单关键词完全不匹配 → false', async () => {
    mocksHoisted.keywordFindMany.mockResolvedValue([{ word: '奈雪' }]);
    expect(await matchKeyword('星巴克发布新品')).toBe(false);
  });
});

describe('matchKeyword 边界条件', () => {
  it('关键词 DB 为空 → 不过滤（返 true）', async () => {
    mocksHoisted.keywordFindMany.mockResolvedValue([]);
    expect(await matchKeyword('任意文本')).toBe(true);
    expect(mocksHoisted.keywordFindMany).toHaveBeenCalledTimes(1);
  });

  it('text 为空 + 有关键词 → false（不误命中）', async () => {
    mocksHoisted.keywordFindMany.mockResolvedValue([{ word: '奈雪' }]);
    expect(await matchKeyword('')).toBe(false);
  });

  it('text 含空白（"  奈雪  发布"）→ 命中（子串匹配对空白不敏感）', async () => {
    mocksHoisted.keywordFindMany.mockResolvedValue([{ word: '奈雪' }]);
    expect(await matchKeyword('  奈雪  发布')).toBe(true);
  });

  it('DB 词带前后空白（" 奈雪 "）→ 当前行为：不命中（filter 只 toLowerCase 不 trim）', async () => {
    // 锁死当前实现：filter.ts:22 只对 keyword 做 toLowerCase，不 trim。
    // 如果将来想"DB 词空白容忍"，必须同时改 filter.ts（不在本次重构范围）。
    mocksHoisted.keywordFindMany.mockResolvedValue([{ word: ' 奈雪 ' }]);
    expect(await matchKeyword('奈雪发布战略')).toBe(false);
  });

  it('关键词是英文子串，匹配中段 → true', async () => {
    mocksHoisted.keywordFindMany.mockResolvedValue([{ word: 'AI' }]);
    // 子串匹配是已知的弱信号 — 这里锁死它的行为，防止后续重构悄悄改变语义
    expect(await matchKeyword('2026 AI 战略报告')).toBe(true);
  });
});

describe('matchKeyword 缓存行为', () => {
  it('连续两次调用 → keyword.findMany 只读一次（5 分钟缓存命中）', async () => {
    mocksHoisted.keywordFindMany.mockResolvedValue([{ word: '奈雪' }]);
    await matchKeyword('奈雪A');
    await matchKeyword('奈雪B');
    await matchKeyword('奈雪C');
    expect(mocksHoisted.keywordFindMany).toHaveBeenCalledTimes(1);
  });

  it('调用 invalidateKeywordCache 后 → 下次强制重读', async () => {
    mocksHoisted.keywordFindMany.mockResolvedValue([{ word: '奈雪' }]);
    await matchKeyword('奈雪A');
    expect(mocksHoisted.keywordFindMany).toHaveBeenCalledTimes(1);

    invalidateKeywordCache();
    await matchKeyword('奈雪B');
    expect(mocksHoisted.keywordFindMany).toHaveBeenCalledTimes(2);
  });

  it('缓存命中时 keyword 集合变化不影响本次会话结果（直到 invalidate）', async () => {
    mocksHoisted.keywordFindMany.mockResolvedValueOnce([{ word: '奈雪' }]);
    const first = await matchKeyword('奈雪文本');
    expect(first).toBe(true);

    // 模拟 DB 在缓存有效期内被外部更新（不加新关键词）
    mocksHoisted.keywordFindMany.mockResolvedValueOnce([
      { word: '奈雪' },
      { word: '瑞幸' },
    ]);

    // 缓存未失效 → 仍按上次缓存的关键词集合判断
    const second = await matchKeyword('瑞幸文本');
    expect(second).toBe(false);
    expect(mocksHoisted.keywordFindMany).toHaveBeenCalledTimes(1);
  });
});