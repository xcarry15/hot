/**
 * 对抗性审查 — dedup 真实场景测试
 *
 * 设计目标：用真实行业新闻场景验证 5 个证据的组合判定是否合理。
 * 每条测试都构造一对文章，验证「应判重」或「应不判重」的预期。
 *
 * 覆盖矩阵：
 *   - 真重复（同事件不同媒体）           → 应判重
 *   - 真无关（同行业不同企业）           → 应不判重
 *   - 同企业不同事件                      → 应不判重
 *   - 标题相似但正文不足                 → 不自动删除
 *   - 单段巧合（样板段 ≥ 150 但总长 < 200）→ 应不判重（多段总长保护）
 *   - 多段 LCS 命中                      → 应判重
 *   - 完整通稿（一字不改）                → 应判重（fingerprint + LCS）
 *   - 改写转载（数值保留学但正文大改）     → 应判重（数值信号胜出）
 *   - brand gate 开/关                    → 控制跨品牌合并
 *   - 1 共享值 + 同日 + LCS 总长           → 应判重
 *   - 1 共享值 + 同日 + LCS 不够           → 应不判重
 */
import { describe, it, expect } from 'vitest';
import {
  extractNumericValues,
  longestCommonSubstring,
  totalLcsRunLengthForTest as totalLcsRunLength,
  isNearDuplicateForTest as isNearDuplicate,
  isSameEventByBodyForTest as isSameEventByBody,
  isSameEventByKeyPointsForTest as isSameEventByKeyPoints,
  DEDUP_LIMITS,
} from '../src/lib/dedup';

// ── 默认 cfg（默认值就是 DEDUP_LIMITS.default） ──
const defaultCfg = {
  windowDays: DEDUP_LIMITS.windowDays.default,
  numericSharedMin: DEDUP_LIMITS.numericSharedMin.default,
  bodyLcsMin: DEDUP_LIMITS.bodyLcsMin.default,
  lcsTotalMin: DEDUP_LIMITS.lcsTotalMin.default,
  brandGateEnabled: DEDUP_LIMITS.brandGateEnabled.default,
  shortBodyThreshold: DEDUP_LIMITS.shortBodyThreshold.default,
};

// ── 工具：构造一篇 AI 后视图 ──
const kpView = (brand: string, keyPoints: string[], publishedAt?: Date) => ({
  brand,
  keyPoints: JSON.stringify(keyPoints),
  publishedAt: publishedAt ?? null,
});

// ================================================================
// totalLcsRunLength 算法正确性（独立验证多段总长逻辑）
// ================================================================
describe('totalLcsRunLength 多段 LCS 总长算法', () => {
  it('完全相同 → 总长 = min(a.length, b.length)', () => {
    const s = '一段用于测试的文本内容'.repeat(10);
    expect(totalLcsRunLength(s, s, 10)).toBe(s.length);
  });

  it('单段 ≥ minRun → 总长 ≥ 该段长', () => {
    // 精确构造 200 字符的共享段（用 'X' 重复，确保 ≥ minRun=150）
    const shared = 'X'.repeat(200);
    const a = shared + 'AA';
    const b = shared + 'BB';
    // 单段 = 200 ≥ 150（bodyLcsMin）算一段，总长 ≥ 200
    expect(longestCommonSubstring(a, b)).toBe(200);
    expect(totalLcsRunLength(a, b, 150)).toBeGreaterThanOrEqual(200);
  });

  it('单段巧合：1 段 180 字符（≥ bodyLcsMin）但总长 < lcsTotalMin', () => {
    const shared = 'Q'.repeat(180);
    const a = shared + 'A'.repeat(100);
    const b = shared + 'B'.repeat(100);
    // 单段 180 ≥ 150 算一段，总长 180 < 200 → 不判重（这正是阈值设计的目的）
    expect(totalLcsRunLength(a, b, 150)).toBe(180);
  });

  it('多段总长：2 段各 120 字符（每段 ≥ 150？不到，但总长 ≥ 200）', () => {
    // 每段 120 < bodyLcsMin=150 → 0 段，总长 = 0
    // 验证：minRun 过滤是关键，单段不够长的不计入总长
    const shared1 = 'A'.repeat(120);
    const shared2 = 'B'.repeat(120);
    const a = shared1 + 'X'.repeat(50) + shared2 + 'A'.repeat(50);
    const b = shared1 + 'Y'.repeat(50) + shared2 + 'B'.repeat(50);
    expect(totalLcsRunLength(a, b, 150)).toBe(0); // 每段都 < 150 → 不算
  });

  it('多段总长：2 段各 160 字符 → 总长 = 320 ≥ 200', () => {
    const shared1 = 'A'.repeat(160);
    const shared2 = 'B'.repeat(160);
    const a = shared1 + 'X'.repeat(50) + shared2 + 'A端';
    const b = shared1 + 'Y'.repeat(50) + shared2 + 'B端';
    expect(totalLcsRunLength(a, b, 150)).toBe(320);
  });

  it('空字符串 → 0', () => {
    expect(totalLcsRunLength('', '任何内容', 10)).toBe(0);
    expect(totalLcsRunLength('任何内容', '', 10)).toBe(0);
  });

  it('MAX_ITER 收敛：大输入不卡死', () => {
    // 10000 字符全相同 → LCS 一次就吃掉整段 → 应快速返回
    const long = 'AB'.repeat(5000);
    const t0 = Date.now();
    const result = totalLcsRunLength(long, long, 150);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000); // 1s 内返回
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(10000);
  });
});

// ================================================================
// 采集时近重复判定 (isNearDuplicate)
// ================================================================
describe('isNearDuplicate 采集时近重复', () => {
  // ── 真重复场景 ──

  it('✅ 真重复：完整通稿（一字不改）— 通过 LCS 总长判定（标题不同导致 fingerprint 不命中，靠正文 LCS）', () => {
    // fingerprint 依赖 title + content 一致；标题不同时不命中，走正文 LCS 总长判定
    const body = '某品牌发布2025年财报'.repeat(30); // 长度足够触发 LCS 总长 ≥ lcsTotalMin
    const r = isNearDuplicate('A标题', body, 'B标题', body, defaultCfg);
    expect(r.isDuplicate).toBe(true);
  });

  it('❌ 标题相似但正文不足 → 不自动删除', () => {
    const r = isNearDuplicate(
      '某品牌Q3财报营收43.31亿元同比下滑12%',
      'A端内容',
      '某品牌Q3财报：营收43.31亿元同比下滑12%',
      'B端内容',
      defaultCfg,
    );
    expect(r.isDuplicate).toBe(false);
  });

  it('✅ 真重复：正文 LCS 总长 ≥ lcsTotalMin', () => {
    // 共享一段 250 字符 → 单段 ≥ 150 + 总长 ≥ 200 → 判重
    const shared = '某品牌2025年Q3财报关键数据：营收43.31亿元同比下滑12%，净亏损2.39亿元同比收窄73.94%，门店1646家净减少152家，市值11亿港元跌96%'.padEnd(250, '。');
    const a = shared + 'A端独有内容';
    const b = shared + 'B端独有内容';
    const r = isNearDuplicate('T1', a, 'T2', b, defaultCfg);
    expect(r.isDuplicate).toBe(true);
  });

  // ── 真无关场景 ──

  it('❌ 真无关：完全不同的两篇文章', () => {
    const r = isNearDuplicate(
      '某品牌Q3财报营收43.31亿元',
      '某品牌Q3营收43.31亿元同比下滑12%，门店1646家',
      '某品牌新品发布会推出0.67港元/罐',
      '某品牌宣布新品0.67港元/罐上市，全国门店同步上线',
      defaultCfg,
    );
    // 标题重合度低（部分品牌词共享但事件完全不同），正文无 LCS
    expect(r.isDuplicate).toBe(false);
  });

  it('❌ 同行业不同企业标题高重合 → 不因标题相似而删除', () => {
    // 同行业的两家不同企业，标题模式相同，但事实主体和数字不同。
    const r = isNearDuplicate(
      '可口可乐Q3财报营收43.31亿美元',
      '可口可乐Q3财报显示营收43.31亿美元同比下滑12%',
      '百事可乐Q3财报营收11亿美元',
      '百事可乐Q3财报显示营收11亿美元同比下滑12%',
      defaultCfg,
    );
    expect(r.isDuplicate).toBe(false);
  });

  // ── 短标题禁用 Jaccard ──

  it('❌ 短标题禁用：两篇短标题重合度高但内容无关 → 不判重', () => {
    // 标题「某品牌Q3财报」只有 8 字符 < titleMinLength=10 → 短标题禁 Jaccard
    const r = isNearDuplicate(
      '某品牌Q3财报',
      'A端完全不同内容讲的是行业宏观数据',
      '某品牌Q3财报',
      'B端完全不同内容讲的是品牌历史回顾',
      defaultCfg,
    );
    expect(r.isDuplicate).toBe(false);
  });

  it('❌ 长标题相似但正文不足 → 不自动删除', () => {
    const r = isNearDuplicate(
      '某品牌Q3财报营收43.31亿元同比下滑12%',
      'A端内容',
      '某品牌Q3财报：营收43.31亿元同比下滑12%',
      'B端内容',
      defaultCfg,
    );
    expect(r.isDuplicate).toBe(false);
  });

  // ── 单段巧合防护 ──

  it('❌ 单段巧合：1 段 50 字符样板（≥ bodyLcsMin=25）但总长 < lcsTotalMin=100 → 不判重', () => {
    const shared = '某品牌2025年Q3财报关键数据：营收43.31亿元同比下滑12%'.padEnd(50, '。');
    const a = shared + 'A端独特内容'.repeat(20);
    const b = shared + 'B端完全不同的独立报道讲其他话题'.repeat(20);
    // 共享 50 ≥ bodyLcsMin(25) 但总长 50 < lcsTotalMin(100)
    // 这正是阈值设计意图：单段巧合被滤掉
    const r = isNearDuplicate('某品牌Q3财报：营收43亿', a, '某品牌股价最新动态', b, defaultCfg);
    expect(r.isDuplicate).toBe(false);
  });
});

// ================================================================
// AI 前正文同事件判定 (isSameEventByBody)
// ================================================================
describe('isSameEventByBody AI 前正文同事件判定', () => {
  const view = (id: string, content: string, publishedAt: Date) => ({
    id,
    cleanContent: content,
    publishedAt,
  });

  // ── 真重复 ──

  it('✅ 数值强信号 + 正文证据：shared ≥ numericSharedMin → 判重', () => {
    const sharedContext = '报告同时披露经营效率、门店质量、区域布局与现金流管理等信息，管理层表示将持续优化业务结构并控制扩张节奏。'.repeat(4);
    const contentA = `某品牌Q3财报：营收43.31亿元同比下滑12%，净亏损2.39亿元，门店1646家。${sharedContext}`;
    const contentB = `某品牌Q3财报营收43.31亿元下滑12%净亏损2.39亿元门店1646家补充信息。${sharedContext}`;
    const numsA = extractNumericValues(contentA);
    const numsB = extractNumericValues(contentB);
    const a = view('a', contentA, new Date('2025-01-01'));
    const b = view('b', contentB, new Date('2025-01-02'));
    expect(isSameEventByBody(a, b, numsA, numsB, defaultCfg)).toBe(true);
  });

  it('✅ 改写转载：数值保留 + 正文大改 → 数值信号胜出', () => {
    const sharedContext = '报告同时披露经营效率、门店质量、区域布局与现金流管理等信息，管理层表示将持续优化业务结构并控制扩张节奏。'.repeat(4);
    const a = `某品牌Q3财报：营收43.31亿元同比增长12%，门店1646家扩张。${sharedContext}`;
    const b = `某品牌最新季度报告数据亮眼：营收43.31亿同比增12%，门店1646家继续扩张海外市场。${sharedContext}`;
    const numsA = extractNumericValues(a);
    const numsB = extractNumericValues(b);
    expect(numsA.size).toBeGreaterThanOrEqual(2);
    expect(isSameEventByBody(
      view('a', a, new Date('2025-01-01')),
      view('b', b, new Date('2025-01-02')),
      numsA, numsB, defaultCfg,
    )).toBe(true);
  });

  // ── 真无关 ──

  it('❌ 真无关：同企业不同事件（季报 vs 新品）→ 不判重', () => {
    const a = '某品牌Q3财报：营收43.31亿元同比下滑12%，净亏损2.39亿元。';
    const b = '某品牌推出新品0.67港元/罐，全国1646家门店同步上线。';
    const numsA = extractNumericValues(a);
    const numsB = extractNumericValues(b);
    // 共享：1646家（但只有 1 个，不够 numericSharedMin=2）
    expect(isSameEventByBody(
      view('a', a, new Date('2025-01-01')),
      view('b', b, new Date('2025-01-02')),
      numsA, numsB, defaultCfg,
    )).toBe(false);
  });

  it('❌ 真无关：同行业不同企业，数字完全不同 → 不判重', () => {
    const a = '可口可乐Q3财报：营收43.31亿美元同比下滑12%。';
    const b = '百事可乐Q3财报：营收11亿美元同比下滑12%。';
    const numsA = extractNumericValues(a);
    const numsB = extractNumericValues(b);
    // 只有 "12%" 共享（1 个 < numericSharedMin=2），且同日 + LCS 也不够
    expect(isSameEventByBody(
      view('a', a, new Date('2025-01-01')),
      view('b', b, new Date('2025-01-02')),
      numsA, numsB, defaultCfg,
    )).toBe(false);
  });

  // ── borderline：1 共享值 + 同日 ──

  it('✅ borderline：1 共享值 + 同日 + LCS 总长 ≥ lcsTotalMin → 判重', () => {
    const sharedValue = '营收43.31亿';
    const filler = '某品牌Q3财报关键数据汇总：详细分析业务表现及未来战略规划方向。'.repeat(5); // ~60 字符
    const sharedBlock = filler.padEnd(220, '。'); // 220 字符共享段
    const a = sharedValue + sharedBlock + 'A端独立内容';
    const b = sharedValue + sharedBlock + 'B端独立内容';
    const numsA = extractNumericValues(a);
    const numsB = extractNumericValues(b);
    // 共享：43.31亿（1 个 < 2）→ 走 borderline：1 共享值 + 同日 + LCS 总长
    const sharedNums = [...numsA].filter(v => numsB.has(v));
    expect(sharedNums.length).toBe(1);
    expect(isSameEventByBody(
      view('a', a, new Date('2025-06-15T08:00:00Z')),
      view('b', b, new Date('2025-06-15T16:00:00Z')),
      numsA, numsB, defaultCfg,
    )).toBe(true);
  });

  it('❌ borderline 不命中：1 共享值 + 同日 + LCS 总长 < lcsTotalMin → 不判重', () => {
    const sharedValue = '营收43.31亿';
    const filler = '某品牌简短报道';
    const a = sharedValue + filler + 'A'.repeat(80);
    const b = sharedValue + filler + 'B'.repeat(80);
    const numsA = extractNumericValues(a);
    const numsB = extractNumericValues(b);
    // 共享 1 个 + 同日，但 LCS 段太短 → 不判重
    expect(isSameEventByBody(
      view('a', a, new Date('2025-06-15T08:00:00Z')),
      view('b', b, new Date('2025-06-15T16:00:00Z')),
      numsA, numsB, defaultCfg,
    )).toBe(false);
  });

  // ── 短文兜底 ──

  it('✅ 短文兜底：无数值 + 两篇短文 + LCS 总长 ≥ lcsTotalMin → 判重', () => {
    const sharedBlock = '某品牌宣布重大战略调整，详细内容涉及多个业务板块的优化与整合计划。'.padEnd(220, '。');
    const a = sharedBlock + 'A端补充';
    const b = sharedBlock + 'B端补充';
    // stripWs 后 < 1500 → 短文
    expect(a.replace(/\s+/g, '').length).toBeLessThan(1500);
    const numsA = extractNumericValues(a);
    const numsB = extractNumericValues(b);
    expect(numsA.size).toBe(0);
    expect(numsB.size).toBe(0);
    expect(isSameEventByBody(
      view('a', a, new Date('2025-01-01')),
      view('b', b, new Date('2025-01-02')),
      numsA, numsB, defaultCfg,
    )).toBe(true);
  });

  it('❌ 短文兜底不命中：无数值 + 短文 + LCS 不够 → 不判重', () => {
    const a = '某品牌战略调整讲了一个完全不同的话题完全没有重叠内容。';
    const b = '另一篇关于该品牌的报道讲的是股价表现和市场反应完全是独立内容。';
    const numsA = extractNumericValues(a);
    const numsB = extractNumericValues(b);
    expect(isSameEventByBody(
      view('a', a, new Date('2025-01-01')),
      view('b', b, new Date('2025-01-02')),
      numsA, numsB, defaultCfg,
    )).toBe(false);
  });
});

// ================================================================
// AI 后 keyPoints 判定 (isSameEventByKeyPoints)
// ================================================================
describe('isSameEventByKeyPoints AI 后同事件判定', () => {
  // ── brand gate 开启 ──

  it('❌ brand gate 开：跨品牌 + 数值命中 → 不判重', () => {
    // brand gate 开启时，跨品牌即使数值匹配也不判重
    const current = kpView('可口可乐', ['营收43.31亿', '门店1646家']);
    const candidate = kpView('百事可乐', ['营收43.31亿', '门店1646家']);
    expect(isSameEventByKeyPoints(
      current, candidate, defaultCfg, ['可口可乐'], 2,
    )).toBe(false);
  });

  it('✅ brand gate 开：同品牌 + 数值 ≥ numericSharedMin → 判重', () => {
    const current = kpView('某品牌', ['营收43.31亿', '门店1646家']);
    const candidate = kpView('某品牌集团', ['营收43.31亿', '门店1646家']);
    // 品牌包含匹配（"某品牌" 是 "某品牌集团" 的子串）
    expect(isSameEventByKeyPoints(
      current, candidate, defaultCfg, ['某品牌'], 2,
    )).toBe(true);
  });

  // ── brand gate 关闭 ──

  it('✅ brand gate 关：跨品牌 + 数值命中 → 判重（激进）', () => {
    const cfgNoGate = { ...defaultCfg, brandGateEnabled: false };
    const current = kpView('可口可乐', ['营收43.31亿', '门店1646家']);
    const candidate = kpView('百事可乐', ['营收43.31亿', '门店1646家']);
    expect(isSameEventByKeyPoints(
      current, candidate, cfgNoGate, ['可口可乐'], 2,
    )).toBe(true);
  });

  // ── borderline：1 共享值 + 同日 ──

  it('✅ 1 共享值 + 同日 + 要点 LCS → 判重', () => {
    const shared = '本次季度报告披露经营数据和后续战略安排。'.repeat(8);
    const current = kpView('某品牌', [`营收43.31亿 ${shared}A`], new Date('2025-06-15T08:00:00Z'));
    const candidate = kpView('某品牌', [`营收43.31亿 ${shared}B`], new Date('2025-06-15T16:00:00Z'));
    expect(isSameEventByKeyPoints(
      current, candidate, defaultCfg, ['某品牌'], 1,
    )).toBe(true);
  });

  it('❌ 1 个常见百分比 + 同日但无要点重叠 → 不判重', () => {
    const current = kpView('某品牌', ['同比增长12%'], new Date('2025-06-15T08:00:00Z'));
    const candidate = kpView('某品牌', ['同比增长12%', '另一项完全不同的指标'], new Date('2025-06-15T16:00:00Z'));
    expect(isSameEventByKeyPoints(
      current, candidate, defaultCfg, ['某品牌'], 1,
    )).toBe(false);
  });

  it('❌ 1 共享值 + 不同日 → 不判重', () => {
    const current = kpView('某品牌', ['营收43.31亿'], new Date('2025-06-15T08:00:00Z'));
    const candidate = kpView('某品牌', ['营收43.31亿'], new Date('2025-06-20T08:00:00Z'));
    // 同品牌、1 共享值、不同日 → 不判重（只 shared >= numericSharedMin 不够）
    expect(isSameEventByKeyPoints(
      current, candidate, defaultCfg, ['某品牌'], 1,
    )).toBe(false);
  });

  // ── LCS 总长兜底 ──

  it('✅ keyPoints LCS 总长 ≥ lcsTotalMin → 判重', () => {
    // keyPoints 文本里有 ≥ 200 字符的公共内容（单段足够长 → 总长 ≥ 200）
    const sharedKp = '某品牌Q3财报关键数据汇总：营收43.31亿元同比下滑12%，净亏损2.39亿元同比收窄73.94%，门店1646家净减少152家，市值11亿港元跌96%，股价0.67港元较发行价大幅缩水。'.repeat(3);
    expect(sharedKp.length).toBeGreaterThanOrEqual(200);
    const current = kpView('某品牌', [sharedKp, '额外要点A']);
    const candidate = kpView('某品牌', [sharedKp, '额外要点B']);
    expect(current.keyPoints.length).toBeGreaterThan(80);
    expect(isSameEventByKeyPoints(
      current, candidate, defaultCfg, ['某品牌'], 0,
    )).toBe(true);
  });

  it('❌ keyPoints LCS 总长 < lcsTotalMin → 不判重', () => {
    const current = kpView('某品牌', ['要点1', '要点2', '要点3']);
    const candidate = kpView('某品牌', ['不同的要点A', '不同的要点B']);
    expect(isSameEventByKeyPoints(
      current, candidate, defaultCfg, ['某品牌'], 0,
    )).toBe(false);
  });
});

// ================================================================
// 跨函数组合对抗：模拟真实 dedupBeforeAI 调用场景
// ================================================================
describe('跨函数组合：模拟 dedupBeforeAI 调用', () => {
  const view = (id: string, content: string, publishedAt: Date) => ({
    id,
    cleanContent: content,
    publishedAt,
  });

  it('✅ 真重复链：3 篇同事件共享 2+ 数值 → 全部判重', () => {
    const sharedContext = '报告同时披露经营效率、门店质量、区域布局与现金流管理等信息，管理层表示将持续优化业务结构并控制扩张节奏。'.repeat(4);
    const baseContent = `某品牌Q3财报：营收43.31亿元同比下滑12%，净亏损2.39亿元，门店1646家。${sharedContext}`;
    const articles = [
      view('a1', baseContent, new Date('2025-01-01')),
      view('a2', baseContent + '补充背景信息', new Date('2025-01-02')),
      view('a3', baseContent + '分析师评论', new Date('2025-01-03')),
    ];
    const nums = articles.map(a => extractNumericValues(a.cleanContent));
    // 任意一对都应该判重
    for (let i = 0; i < articles.length; i++) {
      for (let j = i + 1; j < articles.length; j++) {
        expect(isSameEventByBody(articles[i], articles[j], nums[i], nums[j], defaultCfg)).toBe(true);
      }
    }
  });

  it('❌ 真无关链：3 篇不同事件 → 全部不判重', () => {
    const articles = [
      view('a1', '某品牌Q3财报营收43.31亿同比下滑12%门店1646家', new Date('2025-01-01')),
      view('a2', '某品牌新品发布会推出0.67港元/罐', new Date('2025-01-02')),
      view('a3', '某品牌海外扩张计划新增海外门店500家', new Date('2025-01-03')),
    ];
    const nums = articles.map(a => extractNumericValues(a.cleanContent));
    for (let i = 0; i < articles.length; i++) {
      for (let j = i + 1; j < articles.length; j++) {
        expect(isSameEventByBody(articles[i], articles[j], nums[i], nums[j], defaultCfg)).toBe(false);
      }
    }
  });
});
