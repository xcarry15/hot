'use client';

import { useEffect, useMemo, useState } from 'react';
import { getPublicDateKey } from '@/lib/shared/public-date';
import { TopViewedArticlesCard, type TopViewedArticle } from '@/components/dashboard/dashboard-cards';
import { fetchVisitAnalytics } from '@/features/visit-analytics.client';

type Daily = { day: string; visitors: number; visits: number; views: number; articleViews: number; originalClicks: number; clicks: number };
type Group = { label: string; visits: number; visitors: number };
type MetricKey = 'visitors' | 'visits' | 'views' | 'clicks' | 'articleViews' | 'originalClicks';
type Previous = Record<MetricKey, number> & { start: string; end: string };
type Data = Record<MetricKey, number> & { previous: Previous | null; geoConfigured: boolean; daily: Daily[]; channels: Group[]; regions: Group[]; tools: { label: string; count: number }[]; topViewedArticles: TopViewedArticle[] };
const today = () => getPublicDateKey(Date.now());
const ago = (days: number) => getPublicDateKey(Date.now() - days * 86400000);
const format = (value: number) => value.toLocaleString('zh-CN');

export default function VisitAnalytics() {
  const [start, setStart] = useState(() => ago(29));
  const [end, setEnd] = useState(today);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [trendMetric, setTrendMetric] = useState<MetricKey>('views');
  useEffect(() => {
    const controller = new AbortController();
    setError(''); setData(null);
    void fetchVisitAnalytics<Data>(start, end, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '数据加载失败'); });
    return () => controller.abort();
  }, [start, end, refresh]);
  const days = useMemo(() => {
    const lookup = new Map((data?.daily ?? []).map((row) => [row.day, row]));
    const result: Daily[] = [];
    for (let time = Date.parse(`${start}T00:00:00Z`), last = Date.parse(`${end}T00:00:00Z`); time <= last && result.length < 365; time += 86400000) {
      const day = new Date(time).toISOString().slice(0, 10);
      result.push(lookup.get(day) ?? { day, visitors: 0, visits: 0, views: 0, articleViews: 0, originalClicks: 0, clicks: 0 });
    }
    return result;
  }, [data, start, end]);
  return <div className="space-y-3 p-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="text-sm">访问统计</strong>
      {([['今天', 0], ['昨天', 1], ['近 7 天', 6], ['近 30 天', 29]] as const).map(([label, days]) => <button type="button" key={label} className="border px-2 py-1 hover:bg-muted" onClick={() => { setStart(ago(days)); setEnd(label === '昨天' ? ago(1) : today()); }}>{label}</button>)}
      <input aria-label="开始日期" className="border p-1" type="date" min={ago(364)} max={end} value={start} onChange={(event) => { if (event.target.value) setStart(event.target.value); }} /><span>至</span>
      <input aria-label="结束日期" className="border p-1" type="date" min={start} max={today()} value={end} onChange={(event) => { if (event.target.value) setEnd(event.target.value); }} />
      <button type="button" className="border px-2 py-1 hover:bg-muted" onClick={() => setRefresh((value) => value + 1)}>刷新</button>
    </div>
    <p className="text-muted-foreground">按上海时间统计，保留 365 天；访客按浏览器估算，30 分钟无活动后视为新访问。管理员访问公开页面也计入。</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}{!data && !error && <p role="status">加载中…</p>}
    {data && <>
      {!data.geoConfigured && <p role="status" className="text-amber-700">城市数据库或查询工具不可用，地区暂显示未知。</p>}
      <section aria-label="关键指标" className="space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-1"><h3 className="text-sm font-semibold">关键指标</h3><span className="text-[11px] text-muted-foreground">{data.previous ? `参考上期 ${data.previous.start} 至 ${data.previous.end}` : '上期超出保留期或历史记录不足'}</span></div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-6">
          <Metric label="访客数" value={data.visitors} previous={data.previous?.visitors} detail="浏览器去重" />
          <Metric label="访问次数" value={data.visits} previous={data.previous?.visits} detail="按开始日期" />
          <Metric label="页面浏览量" value={data.views} previous={data.previous?.views} detail={`每位访客 ${data.visitors ? (data.views / data.visitors).toFixed(1) : '—'} 次`} />
          <Metric label="资讯确认浏览" value={data.articleViews} previous={data.previous?.articleViews} detail="停留 800 毫秒" />
          <Metric label="查看原文" value={data.originalClicks} previous={data.previous?.originalClicks} detail="资讯原文入口点击" />
          <Metric label="工具入口点击" value={data.clicks} previous={data.previous?.clicks} detail="本站工具入口" />
        </div>
        <p className="text-[11px] text-muted-foreground">上期为等长日期区间；统计上线初期或浏览器拦截可能导致历史不完整。今天尚未结束，和完整上期不完全可比。</p>
      </section>
      <Section title="每日趋势" detail="选择指标查看走势；无记录日期按 0 展示。访客按日去重，不可直接相加。">
        <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label="趋势指标">
          {([['views', '页面浏览'], ['visitors', '访客'], ['visits', '访问'], ['articleViews', '资讯浏览'], ['originalClicks', '查看原文'], ['clicks', '工具点击']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={trendMetric === key} onClick={() => setTrendMetric(key)} className={`border px-2 py-1 ${trendMetric === key ? 'bg-foreground text-background' : 'hover:bg-muted'}`}>{label}</button>)}
        </div>
        <DailyTrend days={days} metric={trendMetric} />
      </Section>
      <p className="text-muted-foreground">资讯排行按所选日期内的确认浏览排序，点击文章打开工作台详情。</p>
      <TopViewedArticlesCard articles={data.topViewedArticles} onArticleClick={(articleId) => { const url = new URL('/admin', window.location.origin); url.searchParams.set('articleId', articleId); window.location.assign(url.toString()); }} />
      <div className="grid gap-3 md:grid-cols-2">
        <List title="工具入口点击排行" rows={data.tools.map((row) => ({ label: row.label, value: row.count }))} total={data.clicks} />
        <List title="入口渠道" rows={data.channels.map((row) => ({ label: row.label, value: row.visits, extra: `${format(row.visitors)} 访客` }))} total={data.visits} />
        <List title="访问地区" rows={data.regions.map((row) => ({ label: row.label, value: row.visits, extra: `${format(row.visitors)} 访客` }))} total={data.visits} />
      </div>
      <p className="text-muted-foreground">渠道和地区按访问入口归属，同一访客可出现在多个分组；资讯确认浏览与页面浏览量口径不同。浏览器拦截、网络故障和自动访问可能影响统计。</p>
    </>}
  </div>;
}

function Metric({ label, value, previous, detail }: { label: string; value: number; previous?: number; detail: string }) {
  let comparison = '上期不可用';
  if (previous !== undefined) {
    const delta = value - previous;
    comparison = previous === 0 ? (value === 0 ? '上期 0' : '上期 0 · 不计算增幅') : `较上期 ${delta >= 0 ? '+' : ''}${(delta / previous * 100).toFixed(1)}%`;
  }
  return <div className="min-w-0 border bg-background p-2"><div className="text-muted-foreground">{label}</div><strong className="block text-lg tabular-nums">{format(value)}</strong><div className="text-[11px] tabular-nums text-muted-foreground">{comparison}</div><div className="text-[11px] text-muted-foreground">{detail}</div></div>;
}
function Section({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return <section className="min-w-0 border p-2"><h3 className="font-semibold">{title}</h3>{detail && <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>}<div className="mt-2">{children}</div></section>;
}
function DailyTrend({ days, metric }: { days: Daily[]; metric: MetricKey }) {
  const max = Math.max(1, ...days.map((row) => row[metric]));
  const label = { views: '页面浏览', visitors: '访客', visits: '访问', articleViews: '资讯浏览', originalClicks: '查看原文', clicks: '工具点击' }[metric];
  const empty = days.every((row) => row[metric] === 0);
  return <><div className={`relative flex h-28 items-end border-b overflow-hidden ${days.length > 90 ? 'gap-0' : 'gap-px'}`} role="img" aria-label={`每日${label}趋势，详细数值见下方表格`}>{empty && <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">所选范围暂无{label}数据</span>}{days.map((row) => <span key={row.day} title={`${row.day}：${format(row[metric])} ${label}`} className="min-w-0 flex-1 bg-primary/60" style={{ height: `${row[metric] ? Math.max(2, row[metric] / max * 100) : 0}%` }} />)}</div><div className="mt-1 flex justify-between tabular-nums text-muted-foreground"><span>{days[0]?.day}</span><span>峰值 {format(empty ? 0 : max)}</span><span>{days.at(-1)?.day}</span></div><details className="mt-2"><summary className="cursor-pointer">查看每日明细</summary><div className="mt-1 max-h-64 overflow-auto"><table className="w-full min-w-[560px] text-left tabular-nums"><thead><tr><th>日期</th><th>访客</th><th>访问</th><th>页面浏览</th><th>资讯浏览</th><th>查看原文</th><th>工具点击</th></tr></thead><tbody>{[...days].reverse().map((row) => <tr key={row.day} className="border-t"><td>{row.day}</td><td>{format(row.visitors)}</td><td>{format(row.visits)}</td><td>{format(row.views)}</td><td>{format(row.articleViews)}</td><td>{format(row.originalClicks)}</td><td>{format(row.clicks)}</td></tr>)}</tbody></table></div></details></>;
}
function List({ title, rows, total }: { title: string; rows: { label: string; value: number; extra?: string }[]; total: number }) {
  return <Section title={title}>{rows.length ? <ul className="max-h-72 overflow-auto">{rows.map((row, index) => <li key={`${row.label}-${index}`} className="relative overflow-hidden border-t py-1.5"><span aria-hidden="true" className="absolute inset-y-0 left-0 bg-primary/5" style={{ width: `${total > 0 ? Math.min(100, row.value / total * 100) : 0}%` }} /><div className="relative flex justify-between gap-2"><span className="min-w-0 break-words">{row.label}</span><span className="shrink-0 tabular-nums">{format(row.value)}{total > 0 ? ` · ${(row.value / total * 100).toFixed(1)}%` : ''}{row.extra ? ` · ${row.extra}` : ''}</span></div></li>)}</ul> : <p className="text-muted-foreground">暂无数据</p>}</Section>;
}
