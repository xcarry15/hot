import { describe, expect, it } from 'vitest';
import { contentShingleSimilarity, hasEventIdentityQualifierConflict, hasEventPhaseConflict, hasLiteralContentOverlap, isMultiTopicTitle, normalizeEventText, overlapCoefficient, sharedEventAnchors, sharedQuantifiedFacts } from '@/contracts/event-clustering';
import { buildCanonicalEventKey, normalizeEventAction, normalizeEventIdentity } from '@/contracts/event-identity';
import { buildClusterPendingWhere } from '@/lib/pipeline/cluster';
import { buildRuleCandidateAuditEvidence, hasDuplicateReportEvidence, isNearExactReprint, isStrongEventKeyDuplicate } from '@/lib/event-clustering-service';
import { bestPairEvidenceForCandidate, type Candidate } from '@/lib/event/event-cluster-evidence';

type ClusterArticle = Candidate['articles'][number];

function makeClusterArticle(overrides: Partial<ClusterArticle> = {}): ClusterArticle {
  return {
    id: 'article',
    title: '瑞幸咖啡在泰国商标案胜诉',
    cleanContent: '泰国法院作出判决。',
    contentHash: '',
    eventSubjects: '["瑞幸咖啡"]',
    eventAction: '争议维权',
    eventObject: '泰国商标案',
    eventKey: '瑞幸咖啡/争议维权/泰国商标案',
    eventKeyConfidence: 90,
    publishedAt: new Date('2026-07-10T08:00:00Z'),
    createdAt: new Date('2026-07-10T08:00:00Z'),
    ...overrides,
  };
}

function pairEvidence(article: ClusterArticle, member: ClusterArticle) {
  const candidate: Candidate = {
    id: 'event',
    representativeArticleId: member.id,
    clusterReviewStatus: 'confirmed',
    articles: [member],
  };
  const evidence = bestPairEvidenceForCandidate(article, candidate);
  if (!evidence) throw new Error('expected pair evidence');
  return evidence;
}

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
    expect(normalizeEventAction('收购尚未落地')).toBe('计划收购');
    expect(normalizeEventAction('协商入股波兰便利店')).toBe('计划入股');
    expect(normalizeEventAction('终止中国线上经销商合作')).toBe('终止合作');
  });

  it('转载改写正文仍能形成强内容证据', () => {
    const left = 'Popeyes与淘宝闪购加速战略合作，首次在中国推出小店模型。'.repeat(20);
    const right = 'Popeyes联合淘宝闪购深化战略合作，首次在中国探索小店模型。'.repeat(20);
    expect(contentShingleSimilarity(left, right).tokenOverlap).toBeGreaterThan(0.55);
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
    expect(isMultiTopicTitle('西班牙品牌MYKA首店落址香港、赵露思推出美妆品牌、帽总三明治登陆深圳…')).toBe(true);
  });

  it('单一主题的情绪化标题不会被误判为聚合快讯', () => {
    expect(isMultiTopicTitle('加码咖啡，发力下午茶！华莱士推出7款果咖')).toBe(false);
    expect(isMultiTopicTitle('LV也翻车！当品牌维权变成一场舆论自杀')).toBe(false);
  });

  it('同事件改写保留共享主体锚点，不同门店奖项不共享主体锚点', () => {
    expect(sharedEventAnchors('十足便利与七鲜小厨合作', '十足便利店引进七鲜小厨专供菜')).toContain('十足');
    expect(sharedEventAnchors('都江堰邻你超市荣获年度好门店', '永辉超市福州店荣获年度好门店')).toEqual([]);
  });

  it('只把带量纲的相同数值作为可核查事实，不把年份当作数值证据', () => {
    expect(sharedQuantifiedFacts('2026年营收207亿元、开出20家店', '2026年收入207亿元、新开20家店'))
      .toEqual(['207亿元', '20家']);
    expect(sharedQuantifiedFacts('2026年行业报告', '2026年品牌动态')).toEqual([]);
  });

  it('改写稿可用标题或正文重复证据补强身份判断', () => {
    expect(hasDuplicateReportEvidence({
      titleOverlap: 0.29,
      charContentOverlap: 0.01,
      charContentJaccard: 0,
      tokenContentOverlap: 0.75,
      tokenContentJaccard: 0.2,
    })).toBe(true);
    expect(hasDuplicateReportEvidence({
      titleOverlap: 0.26,
      charContentOverlap: 0.08,
      charContentJaccard: 0.01,
      tokenContentOverlap: 0.47,
      tokenContentJaccard: 0.03,
    })).toBe(false);
  });

  it('高置信相同事件键在跟进窗口内可直接归并', () => {
    expect(isStrongEventKeyDuplicate({
      eventKeyMatch: true,
      identityConfidence: 90,
      daysApart: 9,
      titleOverlap: 0.2,
      charContentOverlap: 0.05,
      charContentJaccard: 0.01,
      tokenContentOverlap: 0.1,
      tokenContentJaccard: 0.02,
    })).toBe(true);
    expect(isStrongEventKeyDuplicate({
      eventKeyMatch: true,
      identityConfidence: 90,
      daysApart: 15,
      titleOverlap: 0.2,
      charContentOverlap: 0.05,
      charContentJaccard: 0.01,
      tokenContentOverlap: 0.1,
      tokenContentJaccard: 0.02,
    })).toBe(false);
  });

  it('同标题跨媒体近全文转载即使哈希不同也作为强重复证据', () => {
    expect(isNearExactReprint({
      exactTitle: true,
      tokenContentOverlap: 0.984,
      tokenContentJaccard: 0.892,
      phaseConflict: false,
      identityConflict: false,
      multiTopic: false,
    })).toBe(true);
    expect(isNearExactReprint({
      exactTitle: true,
      tokenContentOverlap: 0.7,
      tokenContentJaccard: 0.5,
      phaseConflict: false,
      identityConflict: false,
      multiTopic: false,
    })).toBe(false);
  });

  it('达到最大重试次数的聚类失败文章不会再次进入批次', () => {
    const now = new Date('2026-07-18T00:00:00Z');
    expect(buildClusterPendingWhere(now)).toEqual({
      fetchStatus: 'fetched',
      aiStatus: 'done',
      eventId: null,
      technicalIgnoredAt: null,
      AND: [
        { OR: [
          { clusterStatus: 'pending' },
          { clusterStatus: 'needs_review' },
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

describe('规则归并对抗样例', () => {
  it('动作和事项改写但标题锚点稳定时自动归并', () => {
    const article = makeClusterArticle({
      id: 'loose-new',
      title: '耐克宣布与海瑟终止线上销售合作',
      eventSubjects: '["耐克", "海瑟"]',
      eventAction: '终止合作',
      eventObject: '线上销售授权',
      eventKey: '耐克+海瑟/终止合作/线上销售授权',
    });
    const member = makeClusterArticle({
      id: 'loose-old',
      title: '耐克与海瑟停止平台销售授权',
      eventSubjects: '["耐克中国", "海瑟"]',
      eventAction: '停止合作',
      eventObject: '平台销售授权',
      eventKey: '耐克中国+海瑟/停止合作/平台销售授权',
    });

    expect(pairEvidence(article, member).decision).toBe('strong');
  });

  it('AI 主体改写但标题锚点仍能驱动归并', () => {
    const article = makeClusterArticle({
      id: 'subject-new',
      title: '海瑟终止与耐克线上销售合作',
      eventSubjects: '["海瑟"]',
      eventAction: '终止合作',
      eventObject: '线上销售授权',
      eventKey: '海瑟/终止合作/线上销售授权',
    });
    const member = makeClusterArticle({
      id: 'subject-old',
      title: '耐克中国与海瑟停止平台销售授权',
      eventSubjects: '["耐克中国"]',
      eventAction: '停止合作',
      eventObject: '平台销售授权',
      eventKey: '耐克中国/停止合作/平台销售授权',
    });

    expect(pairEvidence(article, member).decision).toBe('strong');
  });

  it('不同年份的同类事项仍不会被宽松规则合并', () => {
    const article = makeClusterArticle({
      id: 'year-new',
      title: '瑞幸咖啡发布2026年第二季度业绩',
      eventObject: '2026年第二季度业绩',
      eventKey: '瑞幸咖啡/发布业绩/2026年第二季度业绩',
    });
    const member = makeClusterArticle({
      id: 'year-old',
      title: '瑞幸咖啡发布2026年第一季度业绩',
      eventObject: '2026年第一季度业绩',
      eventKey: '瑞幸咖啡/发布业绩/2026年第一季度业绩',
    });

    expect(pairEvidence(article, member).decision).not.toBe('strong');
  });

  it('同一事件的改写报道以高置信身份直接归并', () => {
    const article = makeClusterArticle({
      id: 'new',
      title: '泰国法院判瑞幸咖啡商标案胜诉',
      cleanContent: '泰国法院作出判决，瑞幸咖啡胜诉。',
    });
    const member = makeClusterArticle({
      id: 'old',
      title: '瑞幸在泰国商标案胜诉',
      cleanContent: '瑞幸咖啡在泰国商标案胜诉。',
      publishedAt: new Date('2026-07-08T08:00:00Z'),
    });

    expect(pairEvidence(article, member).decision).toBe('strong');
  });

  it('低置信但精确且不宽泛的身份仍可直接归并', () => {
    const article = makeClusterArticle({
      id: 'precise-low-confidence-new',
      title: '茶百道调整西南履约网络',
      cleanContent: '文章只披露茶百道近期调整。',
      eventSubjects: '["茶百道"]',
      eventAction: '建设供应链中心',
      eventObject: '成都温江供应链中心',
      eventKey: '茶百道/建设供应链中心/成都温江供应链中心',
      eventKeyConfidence: 60,
    });
    const member = makeClusterArticle({
      id: 'precise-low-confidence-old',
      title: '茶百道披露成都项目进展',
      cleanContent: '报道聚焦该项目的供应链安排。',
      eventSubjects: '["茶百道"]',
      eventAction: '建设供应链中心',
      eventObject: '成都温江供应链中心',
      eventKey: '茶百道/建设供应链中心/成都温江供应链中心',
      eventKeyConfidence: 60,
    });

    const evidence = pairEvidence(article, member);
    expect(evidence.preciseIdentity).toBe(true);
    expect(evidence.decision).toBe('strong');
  });

  it('补充合作方的报道可凭主体包含、事项接近和正文重合归并', () => {
    const sharedContent = '朴朴已接入淘宝闪购服务，首批覆盖福州城区并保持原有配送体系。'.repeat(8);
    const article = makeClusterArticle({
      id: 'pupu-taobao-new',
      title: '朴朴开通淘宝闪购服务',
      cleanContent: sharedContent,
      eventSubjects: '["朴朴", "淘宝闪购"]',
      eventAction: '接入平台',
      eventObject: '淘宝闪购服务',
      eventKey: '朴朴+淘宝闪购/接入平台/淘宝闪购服务',
      eventKeyConfidence: 60,
    });
    const member = makeClusterArticle({
      id: 'pupu-taobao-old',
      title: '淘宝即时零售新增朴朴',
      cleanContent: `${sharedContent}报道补充了平台合作背景。`,
      eventSubjects: '["朴朴"]',
      eventAction: '接入平台',
      eventObject: '淘宝闪购渠道',
      eventKey: '朴朴/接入平台/淘宝闪购渠道',
      eventKeyConfidence: 60,
    });

    const evidence = pairEvidence(article, member);
    expect(evidence.subjectContainment).toBe(true);
    expect(evidence.decision).toBe('strong');
  });

  it('同主体、相近事项与相同量化事实可补强改写报道', () => {
    const article = makeClusterArticle({
      id: 'ccfa-new',
      title: 'CCFA报告：上半年连锁百强销售额达2.1万亿元',
      cleanContent: '中国连锁经营协会发布报告，连锁百强销售额为2.1万亿元。',
      eventSubjects: '["中国连锁经营协会"]',
      eventAction: '发布报告',
      eventObject: '上半年连锁百强销售额2.1万亿元',
      eventKey: '中国连锁经营协会/发布报告/上半年连锁百强销售额2.1万亿元',
    });
    const member = makeClusterArticle({
      id: 'ccfa-old',
      title: '中国连锁经营协会披露百强中期销售额2.1万亿元',
      cleanContent: '协会公布中期榜单，核心统计口径为2.1万亿元。',
      eventSubjects: '["中国连锁经营协会"]',
      eventAction: '发布报告',
      eventObject: '连锁百强中期销售额2.1万亿元',
      eventKey: '中国连锁经营协会/发布报告/连锁百强中期销售额2.1万亿元',
    });

    const evidence = pairEvidence(article, member);
    expect(evidence.sharedQuantifiedFacts).toContain('2.1万亿元');
    expect(evidence.decision).toBe('strong');
  });

  it('宽泛的低置信身份不能单独触发归并', () => {
    const article = makeClusterArticle({
      id: 'generic-new',
      title: '小象超市发布今日动态',
      cleanContent: '正文没有说明具体事项。',
      eventSubjects: '["小象超市"]',
      eventAction: '发布',
      eventObject: '新品',
      eventKey: '小象超市/发布/新品',
      eventKeyConfidence: 60,
    });
    const member = makeClusterArticle({
      id: 'generic-old',
      title: '小象超市调整业务安排',
      cleanContent: '报道也没有可核查细节。',
      eventSubjects: '["小象超市"]',
      eventAction: '发布',
      eventObject: '新品',
      eventKey: '小象超市/发布/新品',
      eventKeyConfidence: 60,
    });

    const evidence = pairEvidence(article, member);
    expect(evidence.preciseIdentity).toBe(false);
    expect(evidence.decision).not.toBe('strong');
  });

  it('同品牌不同门店只记录相近候选，不自动合并', () => {
    const article = makeClusterArticle({
      id: 'new-store',
      title: '永辉超市福州仓山店正式开业',
      eventSubjects: '["永辉超市"]',
      eventAction: '正式开店',
      eventObject: '福州仓山店',
      eventKey: '永辉超市/正式开店/福州仓山店',
    });
    const member = makeClusterArticle({
      id: 'old-store',
      title: '永辉超市北京朝阳店正式开业',
      eventSubjects: '["永辉超市"]',
      eventAction: '正式开店',
      eventObject: '北京朝阳店',
      eventKey: '永辉超市/正式开店/北京朝阳店',
    });

    expect(pairEvidence(article, member).decision).toBe('ambiguous');
  });

  it('同品牌不同新品不自动合并', () => {
    const article = makeClusterArticle({
      id: 'socks',
      title: '7-Eleven推出联名袜子',
      eventSubjects: '["7-Eleven"]',
      eventAction: '发布产品',
      eventObject: '联名袜子',
      eventKey: '7-Eleven/发布产品/联名袜子',
    });
    const member = makeClusterArticle({
      id: 'snack',
      title: '7-Eleven上新便利店零食',
      eventSubjects: '["7-Eleven"]',
      eventAction: '发布产品',
      eventObject: '便利店零食',
      eventKey: '7-Eleven/发布产品/便利店零食',
    });

    expect(pairEvidence(article, member).decision).not.toBe('strong');
  });

  it('预告与已发生的同一项目保留为不同事件', () => {
    const article = makeClusterArticle({
      id: 'plan',
      title: '山姆杭州店计划8月开业',
      eventSubjects: '["山姆"]',
      eventAction: '计划开店',
      eventObject: '杭州店',
      eventKey: '山姆/计划开店/杭州店',
    });
    const member = makeClusterArticle({
      id: 'opened',
      title: '山姆杭州店正式开业',
      eventSubjects: '["山姆"]',
      eventAction: '正式开店',
      eventObject: '杭州店',
      eventKey: '山姆/正式开店/杭州店',
    });

    expect(pairEvidence(article, member).decision).toBe('reject');
  });

  it('同标题的旧报道不会跨跟进窗口自动合并', () => {
    const article = makeClusterArticle({
      id: 'new-quarter',
      title: '瑞幸咖啡发布季度业绩',
      cleanContent: '瑞幸咖啡称将在华南新增供应链投入，并公布经营数据。',
      eventAction: '发布业绩',
      eventObject: '季度经营数据',
      eventKey: '瑞幸咖啡/发布业绩/季度经营数据',
      publishedAt: new Date('2026-07-25T08:00:00Z'),
    });
    const member = makeClusterArticle({
      id: 'old-quarter',
      title: '瑞幸咖啡发布季度业绩',
      cleanContent: '瑞幸咖啡披露上一季度同店增长，并调整门店策略。',
      eventAction: '发布业绩',
      eventObject: '季度经营数据',
      eventKey: '瑞幸咖啡/发布业绩/季度经营数据',
      publishedAt: new Date('2026-06-01T08:00:00Z'),
    });

    expect(pairEvidence(article, member).decision).toBe('reject');
  });

  it('创立与注册成立归一后可合并', () => {
    const eventAction = normalizeEventAction('创立公司');
    const memberAction = normalizeEventAction('注册成立公司');
    const eventKey = buildCanonicalEventKey({ subjects: ['孙东旭'], action: eventAction, object: '东方甄选新公司' });
    const memberEventKey = buildCanonicalEventKey({ subjects: ['孙东旭'], action: memberAction, object: '东方甄选新公司' });
    const article = makeClusterArticle({
      id: 'created',
      title: '孙东旭创立东方甄选新公司',
      eventSubjects: '["孙东旭"]',
      eventAction,
      eventObject: '东方甄选新公司',
      eventKey,
    });
    const member = makeClusterArticle({
      id: 'registered',
      title: '孙东旭注册成立东方甄选新公司',
      eventSubjects: '["孙东旭"]',
      eventAction: memberAction,
      eventObject: '东方甄选新公司',
      eventKey: memberEventKey,
    });

    expect(eventAction).toBe('成立主体');
    expect(memberAction).toBe('成立主体');
    expect(pairEvidence(article, member).decision).toBe('strong');
  });

  it('规则候选审计不携带二次 AI 结论', () => {
    const candidates = [{ candidateEventId: 'event-a', matchedMemberArticleId: 'article-a', ruleEvidence: { reason: '主体与动作相近' } }];
    expect(buildRuleCandidateAuditEvidence(candidates, null)).toEqual({ selectedCandidateEventId: null, candidates });
  });
});
