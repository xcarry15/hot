/**
 * 去重逻辑测试
 *
 * 覆盖:
 * - extractNumericValues（正则、空格、千分位、单位、归一化）
 * - longestCommonSubstring（LCS 长度）
 * - countSharedNumericValues
 */
import { describe, it, expect } from 'vitest';
import {
  extractNumericValues,
  longestCommonSubstring,
  countSharedNumericValues,
} from '../src/lib/dedup';

// ================================================================
// extractNumericValues — 正则修复 + 单位扩充 + 归一化
// ================================================================
describe('extractNumericValues', () => {
  it('从单个要点中提取数值', () => {
    const keyPoints = ['营收43.31亿元同比下滑12%'];
    const values = extractNumericValues(keyPoints);
    // 归一化: 43.31亿元 → 43.31亿（冗余 "元" 被量级隐含）
    expect(values.has('43.31亿')).toBe(true);
    expect(values.has('12%')).toBe(true);
    expect(values.size).toBe(2);
  });

  it('从多个要点中提取多种格式的数值', () => {
    const keyPoints = [
      '赵林年薪137.2万元，彭心172.8万元',
      '市值仅剩11亿港元',
      '股价跌去96％',
      '门店总数1646家',
    ];
    const values = extractNumericValues(keyPoints);
    // 归一化: 万形式保持不变（已是紧凑形式），冗余"元"被去除
    expect(values.has('137.2万')).toBe(true);
    expect(values.has('172.8万')).toBe(true);
    expect(values.has('11亿港元')).toBe(true);
    expect(values.has('96%')).toBe(true);  // 全角％归一化为%
    expect(values.has('1646家')).toBe(true);
    expect(values.size).toBe(5);
  });

  it('过滤裸数字（无单位）', () => {
    const keyPoints = ['营收43.31亿元', '门店数1646家', '增长率12%', '排名第3'];
    const values = extractNumericValues(keyPoints);
    expect(values.has('43.31亿')).toBe(true);
    expect(values.has('1646家')).toBe(true);
    expect(values.has('12%')).toBe(true);
    // "3" is bare (no unit) → should be filtered
    expect(values.has('3')).toBe(false);
    expect(values.size).toBe(3);
  });

  it('年份数字被过滤（太通用，不适合去重）', () => {
    // "2025年" 和 "2026年" 出现在几乎每篇文章中，
    // 作为去重信号会造成大量假阳性，故主动过滤
    const keyPoints = ['2025年营收增长', '2026年计划', '2025'];
    const values = extractNumericValues(keyPoints);
    // 年份值（20xx年）被过滤
    expect(values.has('2025年')).toBe(false);
    expect(values.has('2026年')).toBe(false);
    // 裸 "2025" 也被过滤
    expect(values.has('2025')).toBe(false);
    expect(values.size).toBe(0);
  });

  it('从 JSON 字符串解析', () => {
    const keyPoints = JSON.stringify(['营收43.31亿元', '亏损2.39亿元']);
    const values = extractNumericValues(keyPoints);
    expect(values.has('43.31亿')).toBe(true);
    expect(values.has('2.39亿')).toBe(true);
    expect(values.size).toBe(2);
  });

  it('空数组返回空集合', () => {
    expect(extractNumericValues([]).size).toBe(0);
  });

  it('无匹配数值的要点返回空集合', () => {
    const keyPoints = ['奈雪召开股东大会', '创始人回应薪酬争议'];
    const values = extractNumericValues(keyPoints);
    expect(values.size).toBe(0);
  });

  // ── 新增：空格分隔的数字 ──
  it('数字与单位间有空格时正确提取', () => {
    const keyPoints = ['营收 43.31 亿元', '门店 1,646 家', '增长 12 %'];
    const values = extractNumericValues(keyPoints);
    expect(values.has('43.31亿')).toBe(true);
    expect(values.has('1646家')).toBe(true);
    expect(values.has('12%')).toBe(true);
    expect(values.size).toBe(3);
  });

  // ── 新增：千分位逗号 ──
  it('千分位逗号被正确处理', () => {
    const keyPoints = ['门店总数1,646家', '营收43,310,000元'];
    const values = extractNumericValues(keyPoints);
    expect(values.has('1646家')).toBe(true);
    // 43310000元 → compact to 万: 4331万
    expect(values.has('4331万')).toBe(true);
    expect(values.size).toBe(2);
  });

  // ── 新增：扩展单位 ──
  it('新增单位：倍、吨、亩、人次、天、年、轮', () => {
    const keyPoints = [
      '同比增长3.5倍',
      '产量500吨',
      '面积1200亩',
      '客流10万人次',
      '活动持续30天',
      '历经3轮融资',
    ];
    const values = extractNumericValues(keyPoints);
    expect(values.has('3.5倍')).toBe(true);
    expect(values.has('500吨')).toBe(true);
    expect(values.has('1200亩')).toBe(true);
    expect(values.has('10万人次')).toBe(true);  // 已是紧凑形式
    expect(values.has('30天')).toBe(true);
    expect(values.has('3轮')).toBe(true);
  });

  it('新增单位：平方米、平米、个、位、项', () => {
    const keyPoints = [
      '面积1500平方米',
      '店铺2000平米',
      '卖出5000个',
      '参会200位',
      '完成3项指标',
    ];
    const values = extractNumericValues(keyPoints);
    expect(values.has('1500平方米')).toBe(true);
    expect(values.has('2000平米')).toBe(true);
    expect(values.has('5000个')).toBe(true);
    expect(values.has('200位')).toBe(true);
    expect(values.has('3项')).toBe(true);
  });

  it('欧元、日元单位', () => {
    const keyPoints = ['投资100万欧元', '营收50亿日元'];
    const values = extractNumericValues(keyPoints);
    expect(values.has('100万欧元')).toBe(true);   // 已是紧凑形式
    expect(values.has('50亿日元')).toBe(true);
  });

  // ── 新增：数值归一化（万/亿 vs 基数） ──
  it('"2万家" 和 "20000家" 归一化为相同值', () => {
    const v1 = extractNumericValues(['门店2万家']);
    const v2 = extractNumericValues(['门店20000家']);
    // 2万家 → "2万家"（保持紧凑）, 20000家 → 20000 ≥ 10000 → "2万家"
    expect(v1.has('2万家')).toBe(true);
    expect(v2.has('2万家')).toBe(true);
  });

  it('"1.5亿元" 和 "15000万元" 归一化为相同值', () => {
    const v1 = extractNumericValues(['营收1.5亿元']);
    const v2 = extractNumericValues(['营收15000万元']);
    // 1.5亿元 → "1.5亿"（元被去除）
    // 15000万元 → 15000 ≥ 10000 → promote to "1.5亿"
    expect(v1.has('1.5亿')).toBe(true);
    expect(v2.has('1.5亿')).toBe(true);
  });

  it('"43.31亿元" 归一化后去除冗余"元"', () => {
    const values = extractNumericValues(['营收43.31亿元']);
    expect(values.has('43.31亿')).toBe(true);
    expect(values.has('43.31亿元')).toBe(false);
  });

  // ── 修复：非整除量级的跨表示匹配（历史 bug：裸/带单位数只在整除时压缩）──
  it('"25000元" 和 "2.5万" 归一化为相同值（非整除也压缩）', () => {
    const v1 = extractNumericValues(['补贴25000元']);
    const v2 = extractNumericValues(['补贴2.5万']);
    expect(v1.has('2.5万')).toBe(true);
    expect(v2.has('2.5万')).toBe(true);
  });

  it('"4331000000元" 和 "43.31亿" 归一化为相同值（≥1亿非整除也压缩）', () => {
    const v1 = extractNumericValues(['营收4331000000元']);
    const v2 = extractNumericValues(['营收43.31亿']);
    expect(v1.has('43.31亿')).toBe(true);
    expect(v2.has('43.31亿')).toBe(true);
  });

  it('"12500家" 和 "1.25万家" 归一化为相同值（单位保留）', () => {
    const v1 = extractNumericValues(['门店12500家']);
    const v2 = extractNumericValues(['门店1.25万家']);
    expect(v1.has('1.25万家')).toBe(true);
    expect(v2.has('1.25万家')).toBe(true);
  });

  // ── 原有：multi-article overlap ──
  it('三篇同事件文章的数值重叠检测（模拟真实AI输出）', () => {
    const a1 = [
      '赵林年薪137.2万元彭心172.8万元合计310万元',
      '奈雪市值仅剩11亿港元较发行价跌96%',
      '2025年营收43.31亿元同比下滑12%',
      '净亏损2.39亿元但同比收窄73.94%',
    ];
    const a2 = [
      '奈雪股价0.67港元市值11亿港元跌96%',
      '五年累计亏损超17.66亿元',
      '2025年营收43.31亿元同比下滑',
      '门店总数1646家净减少152家',
    ];
    const a3 = [
      '股价0.67港元较发行价19.8港元跌96%',
      '奈雪市值10.93亿港元约11亿港元',
      '赵林薪酬137.2万元彭心172.8万元',
      '2026年6月24日召开股东大会',
    ];

    const v1 = extractNumericValues(a1);
    const v2 = extractNumericValues(a2);
    const v3 = extractNumericValues(a3);

    // A1 vs A2: 共享 43.31亿, 11亿港元, 96% (2025年已过滤)
    const shared12 = [...v1].filter(x => v2.has(x));
    console.log('A1 vs A2 shared:', shared12);
    expect(shared12.length).toBeGreaterThanOrEqual(2);

    // A2 vs A3: 共享 0.67港元, 11亿港元, 96%
    const shared23 = [...v2].filter(x => v3.has(x));
    console.log('A2 vs A3 shared:', shared23);
    expect(shared23.length).toBeGreaterThanOrEqual(2);

    // A1 vs A3: 共享 137.2万, 172.8万, 11亿港元
    const shared13 = [...v1].filter(x => v3.has(x));
    console.log('A1 vs A3 shared:', shared13);
    expect(shared13.length).toBeGreaterThanOrEqual(2);
  });

  it('同品牌不同事件的数值不重叠', () => {
    const product = ['芒果系列售价18元', '全国门店同步上线'];
    const meeting = ['赵林年薪137.2万元', '市值仅剩11亿港元'];

    const vp = extractNumericValues(product);
    const vm = extractNumericValues(meeting);

    const shared = [...vp].filter(x => vm.has(x));
    expect(shared.length).toBe(0);
  });

  // ── 数值归一化：跨表示匹配 ──
  it('"1000000欧元" 和 "100万欧元" 归一化为相同值', () => {
    const v1 = extractNumericValues(['投资1000000欧元']);
    const v2 = extractNumericValues(['投资100万欧元']);
    // 1000000 → compact to 万 → "100万欧元"
    // 100万欧元 → 保持 "100万欧元"
    expect(v1.has('100万欧元')).toBe(true);
    expect(v2.has('100万欧元')).toBe(true);
  });

  it('"100000人次" 和 "10万人次" 归一化为相同值', () => {
    const v1 = extractNumericValues(['客流100000人次']);
    const v2 = extractNumericValues(['客流10万人次']);
    // 100000人次 → compact to 万 → "10万人次"
    // 10万人次 → 保持 "10万人次"
    expect(v1.has('10万人次')).toBe(true);
    expect(v2.has('10万人次')).toBe(true);
  });

  // ── 新增：中文量级数字（无阿拉伯数字前缀） ──
  it('"百万年薪" 被提取为 "100万"', () => {
    const values = extractNumericValues(['遭股东发难领1元年薪，奈雪董事长需靠百万年薪生活？']);
    expect(values.has('100万')).toBe(true);
    expect(values.has('1元')).toBe(true);
  });

  it('"块" 口语单位归一化为 "元"', () => {
    const values = extractNumericValues(['1块钱年薪拷问奈雪']);
    expect(values.has('1元')).toBe(true);  // 块 → 元
  });

  it('中文量级数字：千万、亿万', () => {
    const values = extractNumericValues(['千万用户', '亿万市场规模']);
    expect(values.has('1000万')).toBe(true);
    expect(values.has('1亿')).toBe(true);
  });

  it('中文量级数字：十万、百亿、二十万', () => {
    const values = extractNumericValues(['十万火急', '百亿补贴', '二十万大军']);
    expect(values.has('10万')).toBe(true);
    expect(values.has('100亿')).toBe(true);
    expect(values.has('20万')).toBe(true);
  });

  it('"百万" 不误匹配 "百分" 或 "百货"', () => {
    // "百分比" contains "百" but not "百万" → should not match
    const values = extractNumericValues(['同比增长百分之十二', '百货商场']);
    expect(values.has('100万')).toBe(false);
  });

  // ── 真实案例：用户数据中的重复对 ──
  it('真实重复案例：1030万事件（同日 + 1 共享值）', () => {
    const a = extractNumericValues(['被LV起诉判赔1030万后，茉莉奶白换头像了']);
    const b = extractNumericValues(['败诉1030万买了个顺风局，茉莉奶白被全网心疼？']);
    expect(a.has('1030万')).toBe(true);
    expect(b.has('1030万')).toBe(true);
    // 1 共享值 + 同日 → dedupBeforeAI 应标记为重复（same-day rule）
    const shared = [...a].filter(x => b.has(x));
    expect(shared).toContain('1030万');
  });

  it('真实重复案例：奈雪百万年薪 vs 1块钱年薪', () => {
    const a = extractNumericValues(['遭股东发难领1元年薪，奈雪董事长需靠百万年薪生活？']);
    const b = extractNumericValues(['1块钱年薪拷问奈雪']);
    // a: 1元, 100万  b: 1元 (块→元)
    expect(a.has('1元')).toBe(true);
    expect(a.has('100万')).toBe(true);
    expect(b.has('1元')).toBe(true);
    // 共享 "1元" — 1 shared value, if same day → dedup
  });
});

// ================================================================
// longestCommonSubstring（从 dedup.ts 导入）
// ================================================================
describe('longestCommonSubstring (LCS)', () => {
  it('完全相同', () => {
    expect(longestCommonSubstring('奈雪股东会', '奈雪股东会')).toBe(5);
  });

  it('共享核心短语', () => {
    const lcs = longestCommonSubstring(
      '奈雪股东会冲突升级董事长被要求降薪',
      '奈雪的茶年度股东大会小股东现场发难'
    );
    expect(lcs).toBe(2);
  });

  it('完全不同', () => {
    expect(longestCommonSubstring('蜜雪冰城开店', '海底捞财报营收')).toBe(0);
  });

  it('部分重叠的品牌名', () => {
    expect(longestCommonSubstring('奈雪的茶', '奈雪')).toBe(2);
  });

  it('共享栏目名前缀仍能被检测（长度计算正确）', () => {
    // isPrefixOnly 已废弃：标题相似度只用 Jaccard，body LCS 不存在栏目前缀问题
    const lcs = longestCommonSubstring(
      '联商头条：北京老佛爷百货将关闭',
      '联商头条：西安赛格最新回应'
    );
    expect(lcs).toBe(5); // "联商头条：" = 5 字符
  });

  it('LCS 长度计算正确', () => {
    const lcs = longestCommonSubstring(
      '奈雪发布2025年财报营收43.31亿元',
      '奈雪2025年业绩报告营收43.31亿'
    );
    // LCS should be "营收43.31亿" = 6+ chars
    expect(lcs).toBeGreaterThanOrEqual(5);
  });
});

// ================================================================
// countSharedNumericValues
// ================================================================
describe('countSharedNumericValues', () => {
  it('相同文本的共享数值为全部', () => {
    const text = '营收43.31亿元同比下滑12%';
    const count = countSharedNumericValues(text, text);
    expect(count).toBe(2); // 43.31亿 + 12%
  });

  it('不同文本无重叠时返回 0', () => {
    const count = countSharedNumericValues(
      '门店总数1646家',
      '营收43.31亿元'
    );
    expect(count).toBe(0);
  });

  it('部分重叠正确计数', () => {
    const count = countSharedNumericValues(
      '奈雪营收43.31亿元同比下滑12%净亏损2.39亿元',
      '奈雪市值11亿港元跌96%营收43.31亿元'
    );
    // 共享: 43.31亿
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('归一化后的数值也能正确匹配', () => {
    const count = countSharedNumericValues(
      '门店2万家',
      '门店20000家'
    );
    // 两者都归一化为 "2万家"
    expect(count).toBe(1);
  });

  it('maxChars 参数限制搜索范围', () => {
    const longText = '营收43.31亿元' + 'x'.repeat(3000) + '门店1646家';
    const count = countSharedNumericValues(longText, '门店1646家', 2000);
    // "门店1646家" is beyond 2000 chars, shared should be 0
    expect(count).toBe(0);
  });
});

// ================================================================
// P0: 正文数值重叠 (process stage)
// ================================================================
describe('P0: 正文数值提取（模拟 process 阶段 cleanContent）', () => {
  it('从正文提取数值', () => {
    const body = '奈雪的茶2025年营收43.31亿元同比下滑12%，净亏损2.39亿元收窄73.94%。门店从1798家收缩至1646家。';
    const values = extractNumericValues(body.slice(0, 2000));
    expect(values.has('43.31亿')).toBe(true);
    expect(values.has('2.39亿')).toBe(true);
    expect(values.has('1646家')).toBe(true);
    // 年份（20xx年）被过滤以降低假阳性
    expect(values.has('2025年')).toBe(false);
    expect(values.has('2025')).toBe(false);
  });

  it('三篇同事件正文数值重叠', () => {
    const a1 = '奈雪营收43.31亿元同比下滑12%净亏损2.39亿元。市值11亿港元股价跌96%';
    const a2 = '奈雪市值11亿港元跌96%营收43.31亿元。门店从1798家减至1646家';
    const a3 = '奈雪股价0.67港元较发行价跌96%，市值10.93亿港元。门店总数1646家';

    const v1 = extractNumericValues(a1);
    const v2 = extractNumericValues(a2);
    const v3 = extractNumericValues(a3);

    const shared12 = [...v1].filter(x => v2.has(x));
    const shared13 = [...v1].filter(x => v3.has(x));
    const shared23 = [...v2].filter(x => v3.has(x));

    console.log('P0 A1 vs A2:', shared12);
    console.log('P0 A1 vs A3:', shared13);
    console.log('P0 A2 vs A3:', shared23);

    // A1 vs A2: 43.31亿, 11亿港元, 96% → ≥2
    expect(shared12.length).toBeGreaterThanOrEqual(2);
    // A2 vs A3: 11亿港元, 96%, 1646家 → ≥2
    expect(shared23.length).toBeGreaterThanOrEqual(2);
  });
});
