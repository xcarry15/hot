/**
 * 访问统计的纯展示逻辑：口径文案、环比表述、趋势分桶。
 * 与 UI 和数据库解耦，便于单测；不引入图表库。
 */

export type MetricKey =
  | 'visitors'
  | 'visits'
  | 'views'
  | 'articleViews'
  | 'originalClicks'
  | 'feishuClicks'
  | 'clicks';

export type Availability = Record<MetricKey, boolean>;

export type MetricRecorded = Record<MetricKey, boolean>;

export type DailyRow = { day: string; hasRecord: boolean; recorded: MetricRecorded } & Record<MetricKey, number>;

export type TrendBucket = {
  key: string;
  label: string;
  value: number;
  hasRecord: boolean;
  days: number;
  /** 周聚合下的访客是日内去重均值，不能当总访客解读。 */
  averaged: boolean;
};

export const METRIC_ORDER: MetricKey[] = [
  'views',
  'visitors',
  'visits',
  'articleViews',
  'originalClicks',
  'feishuClicks',
  'clicks',
];

export const METRIC_DEFS: Record<MetricKey, { name: string; short: string; definition: string }> = {
  views: { name: '页面浏览量', short: '页面浏览', definition: '公开页面被加载的次数，刷新也会累计。同一访客可产生多次浏览。' },
  visitors: { name: '访客数', short: '访客', definition: '按浏览器标识去重；30 分钟无活动后再次访问算新访客。同一访客多日会重复计入。' },
  visits: { name: '访问次数', short: '访问', definition: '同一访客 30 分钟内的连续浏览算一次访问，按访问开始当天归属。' },
  articleViews: { name: '资讯有效阅读', short: '资讯阅读', definition: '打开资讯详情并停留至少 0.8 秒记一次，与页面浏览量口径不同。' },
  originalClicks: { name: '站内原文点击', short: '站内原文', definition: '从本站资讯详情点击「查看原文」的次数。' },
  feishuClicks: { name: '飞书原文点击', short: '飞书原文', definition: '从飞书卡片的「查看原文」跳转到站外的次数。' },
  clicks: { name: '工具入口点击', short: '工具点击', definition: '点击工具目录中已启用工具入口的次数。' },
};

const ADDITIVE_METRICS = new Set<MetricKey>(['views', 'visits', 'articleViews', 'originalClicks', 'feishuClicks', 'clicks']);

/**
 * 超过 90 天按连续 7 天分桶，避免 365 根柱子细到看不见。
 * 可累加指标用周合计；访客无法跨日去重，用有记录日的日均值并显式标注。
 */
export function bucketTrend(days: DailyRow[], metric: MetricKey): TrendBucket[] {
  if (days.length <= 90) {
    return days.map((day) => ({
      key: day.day,
      label: day.day,
      value: day[metric],
      hasRecord: day.recorded[metric],
      days: 1,
      averaged: false,
    }));
  }
  const buckets: TrendBucket[] = [];
  for (let index = 0; index < days.length; index += 7) {
    const slice = days.slice(index, index + 7);
    const recorded = slice.filter((day) => day.recorded[metric]);
    const sum = recorded.reduce((total, day) => total + day[metric], 0);
    const averaged = !ADDITIVE_METRICS.has(metric);
    const value = averaged
      ? (recorded.length ? Math.round(sum / recorded.length) : 0)
      : sum;
    buckets.push({
      key: slice[0].day,
      label: `${slice[0].day.slice(5)} 起 ${slice.length} 天`,
      value,
      hasRecord: recorded.length > 0,
      days: slice.length,
      averaged,
    });
  }
  return buckets;
}

export type ComparisonTone = 'up' | 'down' | 'flat' | 'muted';

/**
 * 无采集记录 / 上期无数据时明确说"不可比"，不输出 -100% 这种误导值。
 * 涨用红、跌用绿（国内习惯）。
 */
export function comparisonText(
  current: number,
  previous: number | null | undefined,
  available: boolean,
  previousAvailable: boolean,
): { text: string; tone: ComparisonTone } {
  if (!available) return { text: '所选范围无采集记录', tone: 'muted' };
  if (previous == null || !previousAvailable) return { text: '无上期数据', tone: 'muted' };
  if (previous === 0) {
    return current === 0
      ? { text: '与上期持平（均为 0）', tone: 'flat' }
      : { text: '上期为 0 · 不计算增幅', tone: 'muted' };
  }
  const delta = current - previous;
  const percent = (delta / previous) * 100;
  if (Math.abs(percent) < 0.05) return { text: '与上期基本持平', tone: 'flat' };
  return {
    text: `${delta > 0 ? '↑' : '↓'} ${Math.abs(percent).toFixed(1)}%`,
    tone: delta > 0 ? 'up' : 'down',
  };
}

export function displayValue(value: number, available: boolean): string {
  return available ? value.toLocaleString('zh-CN') : '—';
}

/** 用于 Y 轴刻度，保证有 0 和不超过 3 个标签。 */
export function axisTicks(maxValue: number): number[] {
  const max = Math.max(1, maxValue);
  const middle = Math.round(max / 2);
  return middle === 0 || middle === max ? [0, max] : [0, middle, max];
}
