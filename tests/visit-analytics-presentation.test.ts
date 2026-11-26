import { describe, expect, it } from 'vitest';
import { axisTicks, bucketTrend, comparisonText, displayValue, type DailyRow } from '@/lib/visit-analytics-presentation';

const day = (index: number) => `2026-11-${String(index).padStart(2, '0')}`;
const off = { visitors: false, views: false, visits: false, articleViews: false, originalClicks: false, feishuClicks: false, clicks: false };
const row = (index: number, views: number, hasRecord = true, recorded = { ...off, views: hasRecord, visitors: hasRecord, visits: hasRecord }): DailyRow => ({
  day: day(index), hasRecord, recorded,
  visitors: views ? 1 : 0, visits: views, views,
  articleViews: 0, originalClicks: 0, feishuClicks: 0, clicks: 0,
});

describe('访问统计展示逻辑', () => {
  it('无采集记录显示不可比，不输出 -100%', () => {
    expect(comparisonText(0, 100, false, true)).toEqual({ text: '所选范围无采集记录', tone: 'muted' });
    expect(comparisonText(0, 100, true, false)).toEqual({ text: '无上期数据', tone: 'muted' });
    expect(comparisonText(0, 0, true, true)).toEqual({ text: '与上期持平（均为 0）', tone: 'flat' });
    expect(comparisonText(5, 0, true, true)).toEqual({ text: '上期为 0 · 不计算增幅', tone: 'muted' });
    expect(displayValue(0, false)).toBe('—');
    expect(displayValue(0, true)).toBe('0');
  });

  it('涨红跌绿方向与近似持平', () => {
    expect(comparisonText(120, 100, true, true)).toEqual({ text: '↑ 20.0%', tone: 'up' });
    expect(comparisonText(80, 100, true, true)).toEqual({ text: '↓ 20.0%', tone: 'down' });
    expect(comparisonText(100, 100, true, true)).toEqual({ text: '与上期基本持平', tone: 'flat' });
  });

  it('不超过 90 天按日展示，保留无记录日', () => {
    const days = [row(1, 3), row(2, 0, false), row(3, 5)];
    const buckets = bucketTrend(days, 'views');
    expect(buckets).toHaveLength(3);
    expect(buckets[1]).toMatchObject({ hasRecord: false, value: 0, averaged: false });
  });

  it('超过 90 天按 7 天分桶，访客取有记录日均值，其余取周合计', () => {
    const days = Array.from({ length: 91 }, (_, index) => row((index % 28) + 1, index < 7 ? 7 : 0, index < 7));
    const visits = bucketTrend(days, 'views');
    const visitors = bucketTrend(days, 'visitors');
    expect(visits).toHaveLength(13);
    expect(visits[0]).toMatchObject({ value: 49, averaged: false, hasRecord: true });
    expect(visits[1]).toMatchObject({ value: 0, hasRecord: false });
    expect(visitors[0]).toMatchObject({ value: 1, averaged: true, hasRecord: true });
    expect(visitors[1]).toMatchObject({ value: 0, averaged: true, hasRecord: false });
  });

  it('同一天不同指标的记录状态独立：有记录但为 0 是真实值，无记录才留空', () => {
    // 第 1 天只有 visits 有采集来源，views 无采集来源（两者值都是 0）。
    const mixed = row(1, 0, false, { ...off, visits: true });
    expect(bucketTrend([mixed], 'visits')[0]).toMatchObject({ hasRecord: true, value: 0 });
    expect(bucketTrend([mixed], 'views')[0]).toMatchObject({ hasRecord: false, value: 0 });
  });

  it('Y 轴刻度含 0 与峰值且不超过三个', () => {
    expect(axisTicks(0)).toEqual([0, 1]);
    expect(axisTicks(9)).toEqual([0, 5, 9]);
  });
});
