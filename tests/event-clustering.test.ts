import { describe, expect, it } from 'vitest';
import { contentShingleSimilarity, hasEventIdentityQualifierConflict, hasEventPhaseConflict, hasLiteralContentOverlap, isMultiTopicTitle, normalizeEventText, overlapCoefficient, sharedEventAnchors } from '@/contracts/event-clustering';
import { buildCanonicalEventKey, normalizeEventAction, normalizeEventIdentity } from '@/contracts/event-identity';
import { buildClusterPendingWhere } from '@/lib/pipeline/cluster';
import { buildAiClusterAuditEvidence, shouldCreateClusterReview, type AiCandidateAudit } from '@/lib/event-clustering-service';

describe('轻量事件聚类规则', () => {
  it('统一标题中的空白、标点和大小写', () => {
    expect(normalizeEventText('  Luckin Coffee：发布 Q2 财报！ ')).toBe('luckincoffee发布q2财报');
  });

  it('同一事件的改写标题保持较高覆盖度', () => {
    const score = overlapCoefficient('胖东来郑州首店正式开业', '胖东来宣布郑州首店开业');
    expect(score).toBeGreaterThan(0.55);
  });

  it('不同事项不会因为品牌相同获得高覆盖度', () => {
    const score = overlapCoefficient('蜜雪冰城登陆港交所', '蜜雪冰城成都鲜啤工厂动工');
    expect(score).toBeLessThan(0.5);
  });

  it('事件身份经程序确定性生成三段式事件键', () => {
    const identity = normalizeEventIdentity({
      subjects: ['胖东来', '郑州文和友'],
      action: '联合调改',
      object: '郑州门店项目',
    });
    expect(buildCanonicalEventKey(identity)).toBe('胖东来+郑州文和友/联合调改/郑州门店项目');
    expect(buildCanonicalEventKey({ ...identity, subjects: [...identity.subjects].reverse() }))
      .toBe('胖东来+郑州文和友/联合调改/郑州门店项目');
  });

  it('将同义长动作压缩为稳定的原子动作', () => {
    expect(normalizeEventAction('发布Q1业绩前瞻')).toBe('发布业绩');
    expect(normalizeEventAction('共同推进卫星店项目并计划新增门店')).toBe('计划开店');
    expect(normalizeEventAction('正式开业')).toBe('正式开店');
  });

  it('转载改写正文仍能形成强内容证据', () => {
    const left = 'Popeyes与淘宝闪购加速战略合作，首次在中国推出小店模型。'.repeat(20);
    const right = 'Popeyes联合淘宝闪购深化战略合作，首次在中国探索小店模型。'.repeat(20);
    expect(contentShingleSimilarity(left, right).overlap).toBeGreaterThan(0.7);
  });

  it('正文快速召回能识别共享长片段', () => {
    expect(hasLiteralContentOverlap('开头不同，但是双方共同宣布小店模型将在中国落地。', '另一段文字，双方共同宣布小店模型将在中国落地。')).toBe(true);
  });

  it('预告与已经发生的结果视为阶段冲突', () => {
    expect(hasEventPhaseConflict('第三届百货节即将启幕', '第三届百货节启幕，首日销售增长')).toBe(true);
  });

  it('不同年份、季度或届次视为事件身份冲突', () => {
    expect(hasEventIdentityQualifierConflict('2026 Q1 财报', '2026年第二季度财报')).toBe(true);
    expect(hasEventIdentityQualifierConflict('第三届百货节', '第四届百货节')).toBe(true);
    expect(hasEventIdentityQualifierConflict('2026 Q1 财报', '2026年第一季度业绩')).toBe(false);
  });

  it('聚合快讯不会直接自动并入其中一个子事件', () => {
    expect(isMultiTopicTitle('华莱士开卖下午茶！蜀海供应链南京新仓投运')).toBe(true);
    expect(isMultiTopicTitle('联商头条：7-11拟入股波兰最大便利店；深圳文和友撤场')).toBe(true);
  });

  it('单一主题的情绪化标题不会被误判为聚合快讯', () => {
    expect(isMultiTopicTitle('加码咖啡，发力下午茶！华莱士推出7款果咖')).toBe(false);
    expect(isMultiTopicTitle('LV也翻车！当品牌维权变成一场舆论自杀')).toBe(false);
  });

  it('同事件改写保留共享主体锚点，不同门店奖项不共享主体锚点', () => {
    expect(sharedEventAnchors('十足便利与七鲜小厨合作', '十足便利店引进七鲜小厨专供菜')).toContain('十足');
    expect(sharedEventAnchors('都江堰邻你超市荣获年度好门店', '永辉超市福州店荣获年度好门店')).toEqual([]);
  });

  it('达到最大重试次数的聚类失败文章不会再次进入批次', () => {
    const now = new Date('2026-07-18T00:00:00Z');
    expect(buildClusterPendingWhere(now)).toEqual({
      fetchStatus: 'fetched',
      aiStatus: 'done',
      eventKey: { not: '' },
      eventId: null,
      technicalIgnoredAt: null,
      AND: [
        { OR: [
          { clusterStatus: 'pending' },
          { clusterStatus: 'failed', clusterRetryCount: { lt: 5 } },
        ] },
        { OR: [
          { nextClusterRetryAt: null },
          { nextClusterRetryAt: { lte: now } },
        ] },
      ],
    });
  });
});

describe('聚类 AI 候选审计', () => {
  const identityEvidence = {
    subjectOverlap: 1,
    actionOverlap: 0.8,
    objectOverlap: 0.75,
    identityScore: 0.87,
    identityConfidence: 85,
    qualifierConflict: false,
    identityConflict: false,
  };
  const candidates: AiCandidateAudit[] = [
    { candidateEventId: 'A', ruleEvidence: { fingerprint: false, exactTitle: false, eventKeyMatch: true, ...identityEvidence, titleOverlap: 0.5, contentOverlap: 0.3, contentJaccard: 0.2, daysApart: 1, phaseConflict: false, multiTopic: false, sharedAnchors: ['品牌A'] }, aiDecision: { sameEvent: false, confidence: 58, reason: '周期不同' } },
    { candidateEventId: 'B', ruleEvidence: { fingerprint: false, exactTitle: false, eventKeyMatch: true, ...identityEvidence, titleOverlap: 0.7, contentOverlap: 0.8, contentJaccard: 0.6, daysApart: 0, phaseConflict: false, multiTopic: false, sharedAnchors: ['品牌B'] }, aiDecision: { sameEvent: true, confidence: 82, reason: '事项一致' } },
  ];

  it('先拒绝 A、再接受 B 时保存全部候选并标记 B', () => {
    expect(buildAiClusterAuditEvidence(candidates, 'B')).toEqual({ selectedCandidateEventId: 'B', candidates });
  });

  it('全部拒绝时 fallback evidence 保留全部候选且无采用项', () => {
    expect(buildAiClusterAuditEvidence(candidates.slice(0, 1), null)).toEqual({ selectedCandidateEventId: null, candidates: candidates.slice(0, 1) });
  });

  it('AI 判断失败不能降级成普通可推送 Event', () => {
    expect(shouldCreateClusterReview(1, [
      { aiDecision: { sameEvent: false, confidence: 0, reason: 'AI 判断失败' } },
    ])).toBe(true);
  });

  it('只有全部高置信判定为不同事件时才允许正常新建 Event', () => {
    expect(shouldCreateClusterReview(2, [
      { aiDecision: { sameEvent: false, confidence: 90, reason: '主体不同' } },
      { aiDecision: { sameEvent: false, confidence: 86, reason: '事项不同' } },
    ])).toBe(false);
    expect(shouldCreateClusterReview(2, [
      { aiDecision: { sameEvent: false, confidence: 90, reason: '主体不同' } },
    ])).toBe(true);
  });
});
