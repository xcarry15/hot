import { describe, expect, it } from 'vitest';
import { buildRuleEventKey, normalizeEventText, overlapCoefficient } from '@/contracts/event-clustering';
import { buildClusterPendingWhere } from '@/lib/pipeline/cluster';

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

  it('规则事件键长度受控', () => {
    expect(buildRuleEventKey('标题'.repeat(200))).toHaveLength(160);
  });

  it('达到最大重试次数的聚类失败文章不会再次进入批次', () => {
    const now = new Date('2026-07-18T00:00:00Z');
    expect(buildClusterPendingWhere(now)).toEqual({
      fetchStatus: 'fetched',
      eventId: null,
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
