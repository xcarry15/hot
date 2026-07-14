/**
 * 去重证据 / 内容对比片段构建测试
 *
 * 目的：锁定"详情区复核是否真重复"所需的内容对比片段正确性：
 *   - LCS 片段：公共子串 + 前后 20 字上下文，两篇各自定位
 *   - 数值片段：共享数值在两篇中的原文位置（含跨写法："2万家" vs "20000家"）
 *   - parseDedupEvidence：canonical 结构识别 + 非本结构回退 null
 */
import { describe, it, expect } from 'vitest';
import {
  buildLcsSnippetsForTest as buildLcsSnippets,
  buildNumericSnippetsForTest as buildNumericSnippets,
} from '../src/lib/dedup';
import { parseDedupEvidence } from '../src/lib/dedup-evidence';

describe('buildLcsSnippets — LCS 内容对比片段', () => {
  it('公共子串 + 前后 20 字上下文，两篇各自定位', () => {
    const textA = '甲乙丙丁' + '重复的公共段落比较长' + '戊己庚辛';
    const textB = '子丑寅卯' + '重复的公共段落比较长' + '辰巳午未';
    const snippets = buildLcsSnippets(textA, textB, 4, 3);
    expect(snippets.length).toBeGreaterThanOrEqual(1);
    const s = snippets[0];
    expect(s.currentShared).toBe('重复的公共段落比较长');
    expect(s.matchedShared).toBe('重复的公共段落比较长');
    expect(s.currentBefore).toBe('甲乙丙丁');
    expect(s.currentAfter).toBe('戊己庚辛');
    expect(s.matchedBefore).toBe('子丑寅卯');
    expect(s.matchedAfter).toBe('辰巳午未');
  });

  it('上下文截断在 20 字以内', () => {
    const shared = '这是两篇文章里完全一样的一段较长文字用于测试';
    const prefixA = 'A'.repeat(60);
    const suffixA = 'B'.repeat(60);
    const prefixB = 'C'.repeat(60);
    const suffixB = 'D'.repeat(60);
    const a = prefixA + shared + suffixA;
    const b = prefixB + shared + suffixB;
    const s = buildLcsSnippets(a, b, 10, 1)[0];
    expect(s.currentShared).toBe(shared);
    // 前后上下文不超过 20 字
    expect(s.currentBefore.length).toBeLessThanOrEqual(20);
    expect(s.currentAfter.length).toBeLessThanOrEqual(20);
    expect(s.currentBefore).toBe('A'.repeat(20));
    expect(s.currentAfter).toBe('B'.repeat(20));
    expect(s.matchedBefore).toBe('C'.repeat(20));
    expect(s.matchedAfter).toBe('D'.repeat(20));
  });

  it('无公共子串返回空数组', () => {
    expect(buildLcsSnippets('蜜雪冰城开店', '海底捞财报营收', 4)).toEqual([]);
  });

  it('多段：sentinel 遮蔽后能找出第二段', () => {
    const seg1 = '第一段公共文字片段';
    const seg2 = '第二段公共文字片段';
    // 前缀/中缀/后缀两篇各不相同，避免与公共段拼成更长的 LCS
    const a = '甲' + seg1 + '中间' + seg2 + '尾';
    const b = '乙' + seg1 + '不同' + seg2 + '末';
    const snippets = buildLcsSnippets(a, b, 4, 3);
    const shareds = snippets.map(s => s.currentShared);
    expect(shareds).toContain(seg1);
    expect(shareds).toContain(seg2);
  });
});

describe('buildNumericSnippets — 数值内容对比片段', () => {
  it('共享数值在两篇中的原文位置 + 上下文', () => {
    const a = '奈雪2025年营收43.31亿元同比下滑12%';
    const b = '奈雪市值11亿港元营收43.31亿元跌96%';
    const snippets = buildNumericSnippets(a, b, ['43.31亿']);
    expect(snippets.length).toBe(1);
    const s = snippets[0];
    expect(s.label).toBe('43.31亿');
    // 两篇里该数值的原文写法
    expect(s.currentShared).toBe('43.31亿元');
    expect(s.matchedShared).toBe('43.31亿元');
    // 上下文落在数值两侧
    expect(s.currentBefore.endsWith('营收')).toBe(true);
    expect(s.currentAfter.startsWith('同比下滑')).toBe(true);
    expect(s.matchedBefore.endsWith('营收')).toBe(true);
  });

  it('跨写法匹配：同一数值不同原文形式分别高亮', () => {
    // "2万家" 与 "20000家" 归一化后都是 "2万家"
    const a = '门店2万家同步上线';
    const b = '门店20000家同步上线';
    const snippets = buildNumericSnippets(a, b, ['2万家']);
    expect(snippets.length).toBe(1);
    const s = snippets[0];
    expect(s.label).toBe('2万家');
    expect(s.currentShared).toBe('2万家');
    expect(s.matchedShared).toBe('20000家'); // 不同写法，分别高亮便于对比
  });

  it('找不到位置的共享值被跳过（不报错）', () => {
    // 共享值在文本里不存在 → 跳过
    const snippets = buildNumericSnippets('门店2万家', '营收43.31亿', ['9999家']);
    expect(snippets).toEqual([]);
  });

  it('最多返回 max 段', () => {
    const a = '营收43.31亿元跌96%门店1646家';
    const b = '营收43.31亿元跌96%门店1646家';
    const snippets = buildNumericSnippets(a, b, ['43.31亿', '96%', '1646家'], 2);
    expect(snippets.length).toBe(2);
  });
});

describe('parseDedupEvidence — canonical 结构识别', () => {
  it('解析合法 canonical 证据', () => {
    const ev = parseDedupEvidence(JSON.stringify({
      methodKey: 'numeric',
      method: '正文数值重叠',
      matchedTitle: '奈雪2025财报',
      matchedUrl: 'https://example.com/a',
      matchedId: 'abc',
      detail: '命中 2 个数值',
      sharedValues: ['43.31亿', '96%'],
      snippets: [],
    }));
    expect(ev).not.toBeNull();
    expect(ev?.methodKey).toBe('numeric');
    expect(ev?.matchedUrl).toBe('https://example.com/a');
    expect(ev?.sharedValues).toEqual(['43.31亿', '96%']);
  });

  it('非 canonical（缺 methodKey/method/detail）→ null（回退通用展示）', () => {
    // 旧格式 discarded detail（filter:short 等）
    expect(parseDedupEvidence(JSON.stringify({ titleLength: 5 }))).toBeNull();
    expect(parseDedupEvidence(JSON.stringify({ method: 'x' }))).toBeNull(); // 缺 methodKey/detail
  });

  it('空 / 非法 JSON → null', () => {
    expect(parseDedupEvidence(null)).toBeNull();
    expect(parseDedupEvidence('')).toBeNull();
    expect(parseDedupEvidence('not json')).toBeNull();
  });
});
