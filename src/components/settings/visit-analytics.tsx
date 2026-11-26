'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatPublicTime, getPublicDateKey } from '@/lib/shared/public-date';
import { TopViewedArticlesCard, type TopViewedArticle } from '@/components/dashboard/dashboard-cards';
import { fetchVisitAnalytics } from '@/features/visit-analytics.client';
import { Skeleton } from '@/components/ui/skeleton';
import type { CompareMode } from '@/lib/visit-analytics-service';
import {
  METRIC_DEFS,
  METRIC_ORDER,
  axisTicks,
  bucketTrend,
  comparisonText,
  displayValue,
  type Availability,
  type ComparisonTone,
  type DailyRow,
  type MetricKey,
  type MetricRecorded,
  type TrendBucket,
} from '@/lib/visit-analytics-presentation';

type Daily = Record<MetricKey, number> & { day: string; recorded: Record<MetricKey, boolean> };
type Group = { label: string; visits: number; visitors: number };
type Previous = Record<MetricKey, number> & { start: string; end: string; available: Availability };
type Data = Record<MetricKey, number> & {
  previous: Previous | null;
  compareMode: CompareMode;
  generatedAt: string;
  available: Availability;
  geoConfigured: boolean;
  daily: Daily[];
  channels: Group[];
  regions: Group[];
  tools: { label: string; count: number }[];
  topViewedArticles: TopViewedArticle[];
};

type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'custom';
const today = () => getPublicDateKey(Date.now());
const ago = (days: number) => getPublicDateKey(Date.now() - days * 86400000);
const format = (value: number) => value.toLocaleString('zh-CN');
const TONE_CLASS: Record<ComparisonTone, string> = {
  up: 'text-red-600',
  down: 'text-emerald-600',
  flat: 'text-muted-foreground',
  muted: 'text-muted-foreground',
};
const COMPARE_LABEL: Record<CompareMode, string> = {
  previous: '上一周期',
  week: '上周同日',
  off: '不对比',
};

export default function VisitAnalytics() {
  const [start, setStart] = useState(() => ago(29));
  const [end, setEnd] = useState(today);
  const [preset, setPreset] = useState<Preset>('30d');
  const [compare, setCompare] = useState<CompareMode>('previous');
  const [data, setData] = useState<Data | null>(null);
  const [loadedRange, setLoadedRange] = useState<{ start: string; end: string; compare: CompareMode } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [trendMetric, setTrendMetric] = useState<MetricKey>('views');

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setLoading(true);
    void fetchVisitAnalytics<Data>(start, end, compare, controller.signal)
      .then((result) => { if (!controller.signal.aborted) { setData(result); setLoadedRange({ start, end, compare }); } })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '数据加载失败');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [start, end, compare, refresh]);

  const days = useMemo<DailyRow[]>(() => {
    const lookup = new Map((data?.daily ?? []).map((row) => [row.day, row]));
    const result: DailyRow[] = [];
    // 数据框架必须跟随「已加载区间」：stale 期间下方仍是旧数据，日期框架也要用旧区间，
    // 否则会用新区间日期去查旧数据，趋势图全空却提示"下方仍为旧区间数据"，自相矛盾。
    const frameStart = data && loadedRange ? loadedRange.start : start;
    const frameEnd = data && loadedRange ? loadedRange.end : end;
    for (let time = Date.parse(`${frameStart}T00:00:00Z`), last = Date.parse(`${frameEnd}T00:00:00Z`); time <= last && result.length < 365; time += 86400000) {
      const day = new Date(time).toISOString().slice(0, 10);
      const found = lookup.get(day);
      const noRecord = METRIC_ORDER.reduce((acc, key) => { acc[key] = false; return acc; }, {} as MetricRecorded);
      result.push({
        day,
        hasRecord: Boolean(found),
        recorded: found?.recorded ?? noRecord,
        visitors: found?.visitors ?? 0,
        visits: found?.visits ?? 0,
        views: found?.views ?? 0,
        articleViews: found?.articleViews ?? 0,
        originalClicks: found?.originalClicks ?? 0,
        feishuClicks: found?.feishuClicks ?? 0,
        clicks: found?.clicks ?? 0,
      });
    }
    return result;
  }, [data, loadedRange, start, end]);

  const buckets = useMemo(() => bucketTrend(days, trendMetric), [days, trendMetric]);
  const rangePresets: Array<{ key: Exclude<Preset, 'custom'>; label: string; start: string; end: string }> = [
    { key: 'today', label: '今天', start: ago(0), end: today() },
    { key: 'yesterday', label: '昨天', start: ago(1), end: ago(1) },
    { key: '7d', label: '近 7 天', start: ago(6), end: today() },
    { key: '30d', label: '近 30 天', start: ago(29), end: today() },
  ];
  const applyPreset = (item: (typeof rangePresets)[number]) => {
    setStart(item.start);
    setEnd(item.end);
    setPreset(item.key);
  };
  // 基于数据的提示一律用「已加载区间/对比模式」，否则 stale 状态下会用新筛选值判断旧数据。
  const isPartialDay = loadedRange?.end === today();
  const overlapDays = data?.previous && data.compareMode === 'week' && loadedRange
    ? Math.max(0, (Math.min(Date.parse(`${loadedRange.end}T00:00:00Z`), Date.parse(`${data.previous.end}T00:00:00Z`))
      - Math.max(Date.parse(`${loadedRange.start}T00:00:00Z`), Date.parse(`${data.previous.start}T00:00:00Z`))) / 86400000 + 1)
    : 0;
  const isStale = loading && Boolean(data) && Boolean(loadedRange)
    && (loadedRange!.start !== start || loadedRange!.end !== end || loadedRange!.compare !== compare);
  const updatedAt = data ? formatPublicTime(new Date(data.generatedAt)) : '';

  return <div className="space-y-3 p-2 text-[13px]">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="text-sm">访问统计</strong>
      {rangePresets.map((item) => (
        <button type="button" key={item.key} aria-pressed={preset === item.key}
          className={`border px-2 py-1 ${preset === item.key ? 'bg-foreground text-background' : 'hover:bg-muted'}`}
          onClick={() => applyPreset(item)}>{item.label}</button>
      ))}
      <input aria-label="开始日期" className="border p-1" type="date" min={ago(364)} max={end} value={start}
        onChange={(event) => { if (event.target.value) { setStart(event.target.value); setPreset('custom'); } }} />
      <span>至</span>
      <input aria-label="结束日期" className="border p-1" type="date" min={start} max={today()} value={end}
        onChange={(event) => { if (event.target.value) { setEnd(event.target.value); setPreset('custom'); } }} />
      <label className="flex items-center gap-1">对比
        <select aria-label="对比基准" className="border p-1" value={compare} onChange={(event) => setCompare(event.target.value as CompareMode)}>
          <option value="previous">上一周期</option>
          <option value="week">上周同日</option>
          <option value="off">不对比</option>
        </select>
      </label>
      <button type="button" className="border px-2 py-1 hover:bg-muted disabled:opacity-60" disabled={loading}
        onClick={() => setRefresh((value) => value + 1)}>{loading ? '更新中…' : '刷新'}</button>
      {updatedAt && loadedRange && <span className="text-[11px] text-muted-foreground">上次更新 {updatedAt}（{loadedRange.start} 至 {loadedRange.end}）</span>}
    </div>

    {isStale && <p role="status" className="border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">
      正在加载 {start} 至 {end}（{COMPARE_LABEL[compare]}），下方仍为 {loadedRange!.start} 至 {loadedRange!.end} 的数据。
    </p>}

    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border border-destructive bg-destructive/5 px-2 py-1.5 text-destructive">
      <span>{data ? `刷新失败：${error}（下方仍为上次成功读取的数据）` : error}</span>
      <button type="button" className="border px-2 py-0.5 hover:bg-muted" onClick={() => setRefresh((value) => value + 1)}>重试</button>
    </div>}

    {!data && !error && <LoadingSkeleton />}

    {data && <>
      {!data.geoConfigured && <p role="status" className="text-amber-700">城市数据库或查询工具不可用，地区暂显示未知。</p>}
      {isPartialDay && data.compareMode !== 'off' && <p className="text-amber-700">今天尚未结束，与完整对比区间不完全可比。</p>}
      {overlapDays > 1 && <p className="text-amber-700">所选区间超过 7 天，「上周同日」整体前移 7 天后与原区间重叠 {overlapDays} 天，涨跌幅度会被稀释；如需严格对比请改用「上一周期」或缩短到 7 天。</p>}

      <section aria-label="关键指标" className="space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-1">
          <h3 className="text-sm font-semibold">关键指标</h3>
          {data.previous
            ? <span className="text-[11px] text-muted-foreground">对比 {COMPARE_LABEL[data.compareMode]} {data.previous.start} 至 {data.previous.end}</span>
            : <span className="text-[11px] text-muted-foreground">{data.compareMode === 'off' ? '未启用对比' : '对比区间超出保留期或采集历史不足'}</span>}
        </div>
        <div className="grid gap-2">
          <PrimaryMetric metric="views" value={data.views} previous={data.previous?.views} available={data.available.views}
            previousAvailable={data.previous?.available.views ?? false} visitors={data.visitors} visitorsAvailable={data.available.visitors} />
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {METRIC_ORDER.filter((key) => key !== 'views').map((key) => (
              <SmallMetric key={key} metric={key} value={data[key]} previous={data.previous?.[key]}
                available={data.available[key]} previousAvailable={data.previous?.available[key] ?? false} />
            ))}
          </div>
        </div>
        <details className="text-[11px] text-muted-foreground">
          <summary className="cursor-pointer">指标口径说明</summary>
          <ul className="mt-1 grid gap-1 md:grid-cols-2">
            {METRIC_ORDER.map((key) => <li key={key}><span className="font-medium text-foreground">{METRIC_DEFS[key].name}：</span>{METRIC_DEFS[key].definition}</li>)}
          </ul>
          <p className="mt-1">环比按 ↑ 红色表示上升、↓ 绿色表示下降（国内涨跌配色），与「概览」页用绿色表示质量好的配色含义不同。</p>
          <p className="mt-1">访客按浏览器估算，30 分钟无活动后视为新访问；管理员访问公开页面也计入。浏览器拦截、网络故障和自动访问可能影响统计。</p>
        </details>
      </section>

      <Section title="每日趋势" detail={buckets[0]?.averaged
        ? '超过 90 天按 7 天分桶，访客显示为有记录日的日均值；无记录区间留空。'
        : '选择指标查看走势；无采集记录的日期留空，不按 0 画点。'}>
        <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label="趋势指标">
          {METRIC_ORDER.map((key) => (
            <button type="button" key={key} aria-pressed={trendMetric === key} onClick={() => setTrendMetric(key)}
              className={`border px-2 py-1 ${trendMetric === key ? 'bg-foreground text-background' : 'hover:bg-muted'}`}>
              {METRIC_DEFS[key].short}
            </button>
          ))}
        </div>
        <TrendChart buckets={buckets} label={METRIC_DEFS[trendMetric].name} />
        <details className="mt-2">
          <summary className="cursor-pointer">查看每日明细</summary>
          <div className="mt-1 max-h-64 overflow-auto">
            <table className="w-full min-w-[560px] text-left tabular-nums">
              <thead><tr><th>日期</th>{METRIC_ORDER.map((key) => <th key={key}>{METRIC_DEFS[key].short}</th>)}</tr></thead>
              <tbody>{[...days].reverse().map((row) => (
                <tr key={row.day} className="border-t">
                  <td>{row.day}</td>
                  {METRIC_ORDER.map((key) => <td key={key}>{row.recorded[key] ? format(row[key]) : '—'}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      </Section>

      <p className="text-muted-foreground">资讯排行按所选日期内的有效阅读排序，点击文章打开工作台详情。</p>
      <TopViewedArticlesCard articles={data.topViewedArticles} onArticleClick={(articleId) => {
        const url = new URL('/admin', window.location.origin);
        url.searchParams.set('articleId', articleId);
        url.searchParams.set('settingsTab', 'dashboard');
        url.searchParams.set('dashboardView', 'analytics');
        window.location.assign(url.toString());
      }} />
      <div className="grid gap-3 md:grid-cols-2">
        <List title="工具入口点击排行" rows={data.tools.map((row) => ({ label: row.label, value: row.count }))} total={data.clicks} />
        <List title="入口渠道" rows={data.channels.map((row) => ({ label: row.label, value: row.visits, extra: `${format(row.visitors)} 访客` }))} total={data.visits} />
        <List title="访问地区" rows={data.regions.map((row) => ({ label: row.label, value: row.visits, extra: `${format(row.visitors)} 访客` }))} total={data.visits} />
      </div>
      <p className="text-muted-foreground">渠道和地区按访问入口归属，同一访客可出现在多个分组；资讯有效阅读与页面浏览量口径不同。</p>
    </>}
  </div>;
}

function LoadingSkeleton() {
  return <div className="space-y-2" role="status" aria-label="加载中">
    <div className="grid gap-2">
      <Skeleton className="h-24 w-full" />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-20 w-full" />)}</div>
    </div>
    <Skeleton className="h-48 w-full" />
    <span className="sr-only">加载中…</span>
  </div>;
}

function Delta({ current, previous, available, previousAvailable }: {
  current: number; previous: number | null | undefined; available: boolean; previousAvailable: boolean;
}) {
  const result = comparisonText(current, previous, available, previousAvailable);
  return <span className={`tabular-nums ${TONE_CLASS[result.tone]}`}>{result.text}</span>;
}

function PrimaryMetric({ metric, value, previous, available, previousAvailable, visitors, visitorsAvailable }: {
  metric: MetricKey; value: number; previous: number | null | undefined; available: boolean; previousAvailable: boolean;
  visitors: number; visitorsAvailable: boolean;
}) {
  const perVisitor = visitorsAvailable && visitors > 0 ? (value / visitors).toFixed(1) : '—';
  return <div className="border bg-background p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{METRIC_DEFS[metric].name} <span className="text-[11px]">· 核心指标</span></span>
      <Delta current={value} previous={previous} available={available} previousAvailable={previousAvailable} />
    </div>
    <strong className="mt-1 block text-3xl tabular-nums">{displayValue(value, available)}</strong>
    <div className="mt-1 text-[11px] text-muted-foreground">
      {available ? `每位访客 ${perVisitor} 次浏览` : '所选范围无采集记录'}
    </div>
  </div>;
}

function SmallMetric({ metric, value, previous, available, previousAvailable }: {
  metric: MetricKey; value: number; previous: number | null | undefined; available: boolean; previousAvailable: boolean;
}) {
  return <div className="min-w-0 border bg-background p-2" title={METRIC_DEFS[metric].definition}>
    <div className="truncate text-muted-foreground">{METRIC_DEFS[metric].name}</div>
    <strong className="block text-lg tabular-nums">{displayValue(value, available)}</strong>
    <div className="text-[11px]"><Delta current={value} previous={previous} available={available} previousAvailable={previousAvailable} /></div>
  </div>;
}

function Section({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return <section className="min-w-0 border p-2"><h3 className="font-semibold">{title}</h3>{detail && <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>}<div className="mt-2">{children}</div></section>;
}

function TrendChart({ buckets, label }: { buckets: TrendBucket[]; label: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setWidth(Math.max(280, element.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setHover(null), [buckets]);

  const height = 150;
  const pad = { left: 42, right: 12, top: 12, bottom: 24 };
  const innerWidth = Math.max(1, width - pad.left - pad.right);
  const innerHeight = height - pad.top - pad.bottom;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.value));
  const ticks = axisTicks(max);
  const x = (index: number) => pad.left + (buckets.length <= 1 ? innerWidth / 2 : (index / (buckets.length - 1)) * innerWidth);
  const y = (value: number) => pad.top + innerHeight - (value / max) * innerHeight;
  // 无采集记录才显示空态；"有记录但值为 0"是真实数据，必须画在 0 线上。
  const empty = buckets.every((bucket) => !bucket.hasRecord);
  const segments: string[] = [];
  let current = '';
  buckets.forEach((bucket, index) => {
    if (!bucket.hasRecord) {
      if (current) segments.push(current);
      current = '';
      return;
    }
    const point = `${x(index).toFixed(1)},${y(bucket.value).toFixed(1)}`;
    current = current ? `${current} L${point}` : `M${point}`;
  });
  if (current) segments.push(current);
  const labelIndexes = [...new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1])].filter((index) => index >= 0);

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!buckets.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / Math.max(1, rect.width)) * width;
    const index = Math.round(((px - pad.left) / innerWidth) * (buckets.length - 1));
    setHover(Math.max(0, Math.min(buckets.length - 1, index)));
  };

  return <div ref={containerRef} className="relative w-full">
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={`每日${label}趋势，详细数值见下方表格`} onMouseMove={handleMove} onMouseLeave={() => setHover(null)}>
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke="currentColor" strokeOpacity="0.15" />
          <text x={pad.left - 6} y={y(tick) + 4} textAnchor="end" className="fill-muted-foreground" fontSize="10">{tick}</text>
        </g>
      ))}
      {labelIndexes.map((index) => {
        const bucket = buckets[index];
        // 单日桶 label 是 YYYY-MM-DD，取 MM-DD；周桶 label 是「MM-DD 起 N 天」，取起始 MM-DD。
        // 不能用统一的 slice(5)，否则周桶三个标签都会变成「 起 N 天」这种无意义重复文本。
        const tickLabel = !bucket ? '' : bucket.days > 1 ? bucket.label.slice(0, 5) : bucket.label.slice(5);
        return <text key={index} x={x(index)} y={height - 6} textAnchor={index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle'}
          className="fill-muted-foreground" fontSize="10">{tickLabel}</text>;
      })}
      {segments.map((path, index) => <path key={index} d={path} fill="none" stroke="hsl(var(--primary))" strokeWidth="2" strokeLinejoin="round" />)}
      {/* 每个有效点都画 marker，否则"今天/昨天"单点区间只有 M 命令，图上什么都看不到。 */}
      {buckets.map((bucket, index) => bucket.hasRecord && (
        <circle key={bucket.key} cx={x(index)} cy={y(bucket.value)} r={hover === index ? 3.5 : 2} fill="hsl(var(--primary))" />
      ))}
      {empty && <text x={width / 2} y={height / 2} textAnchor="middle" className="fill-muted-foreground" fontSize="12">所选范围暂无{label}数据</text>}
    </svg>
    {hover != null && buckets[hover] && (
      <div className="pointer-events-none absolute top-0 z-10 border bg-background px-2 py-1 text-[11px] shadow-sm"
        style={{ left: `${Math.min(88, Math.max(0, (x(hover) / width) * 100))}%` }}>
        <div className="tabular-nums">{buckets[hover].label}</div>
        <div className="tabular-nums">{buckets[hover].hasRecord
          ? `${format(buckets[hover].value)} ${label}${buckets[hover].averaged ? '（日均）' : ''}`
          : '无采集记录'}</div>
      </div>
    )}
  </div>;
}

function List({ title, rows, total }: { title: string; rows: { label: string; value: number; extra?: string }[]; total: number }) {
  return <Section title={title}>{rows.length ? <ul className="max-h-72 overflow-auto">{rows.map((row, index) => (
    <li key={`${row.label}-${index}`} className="relative overflow-hidden border-t py-1.5">
      <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-primary/5" style={{ width: `${total > 0 ? Math.min(100, row.value / total * 100) : 0}%` }} />
      <div className="relative flex justify-between gap-2">
        <span className="min-w-0 break-words">{row.label}</span>
        <span className="shrink-0 tabular-nums">{format(row.value)}{total > 0 ? ` · ${(row.value / total * 100).toFixed(1)}%` : ''}{row.extra ? ` · ${row.extra}` : ''}</span>
      </div>
    </li>
  ))}</ul> : <p className="text-muted-foreground">暂无数据</p>}</Section>;
}
