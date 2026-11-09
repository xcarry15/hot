'use client';
import { useEffect, useState } from 'react';
import { getPublicDateKey } from '@/lib/shared/public-date';

type Data = { geoConfigured: boolean; visitors: number; visits: number; views: number; clicks: number; daily: { day: string; visitors: number; visits: number; views: number }[]; channels: { label: string; visits: number; visitors: number }[]; regions: { label: string; visits: number; visitors: number }[]; tools: { label: string; count: number }[]; articles: { label: string; count: number; status: string }[] };
const today = () => getPublicDateKey(Date.now());
const ago = (days: number) => getPublicDateKey(Date.now() - days * 86400000);
export default function VisitAnalytics() {
  const [start, setStart] = useState(() => ago(29));
  const [end, setEnd] = useState(today);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setError(''); setData(null);
    void fetch(`/api/visit-analytics?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, { signal: controller.signal }).then(async (r) => { if (!r.ok) throw new Error('日期范围无效或数据加载失败'); return r.json() as Promise<Data>; }).then(setData).catch((e) => { if (!controller.signal.aborted) setError(String(e.message)); });
    return () => controller.abort();
  }, [start, end]);
  return <div className="space-y-3 p-2 text-xs">
    <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">访问统计</strong>{[['今天', 0], ['昨天', 1], ['近 7 天', 6], ['近 30 天', 29]].map(([label, days]) => <button key={label} className="border px-2 py-1" onClick={() => { const d = Number(days); setStart(ago(d)); setEnd(label === '昨天' ? ago(1) : today()); }}>{label}</button>)}<input aria-label="开始日期" className="border p-1" type="date" min={ago(364)} max={end} value={start} onChange={(e) => setStart(e.target.value)} /><span>至</span><input aria-label="结束日期" className="border p-1" type="date" min={start} max={today()} value={end} onChange={(e) => setEnd(e.target.value)} /></div>
    <p className="text-muted-foreground">访客按浏览器估算；30 分钟无活动后重新访问计为新访问。统计可能漏计，包含管理员公开页面访问；保留 365 天。</p>
    {error && <p role="alert">{error}</p>}{!data && !error && <p>加载中…</p>}
    {data && <>{!data.geoConfigured && <p role="status" className="text-amber-700">城市数据库或查询工具不可用，地区暂显示未知。</p>}<div className="grid grid-cols-2 gap-2 md:grid-cols-4">{[['访客数', data.visitors], ['访问次数', data.visits], ['浏览量', data.views], ['工具点击', data.clicks]].map(([label, value]) => <div key={label} className="border p-2"><div className="text-muted-foreground">{label}</div><strong className="text-xl">{Number(value).toLocaleString()}</strong></div>)}</div>
      <Section title="每日趋势"><table className="w-full text-left"><thead><tr><th>日期</th><th>访客</th><th>访问</th><th>浏览</th></tr></thead><tbody>{data.daily.map((r) => <tr key={r.day}><td>{r.day}</td><td>{r.visitors}</td><td>{r.visits}</td><td>{r.views}</td></tr>)}</tbody></table></Section>
      <div className="grid gap-3 md:grid-cols-2"><List title="资讯浏览排行（800 毫秒确认）" rows={data.articles.filter((r) => r.count > 0).map((r) => ({ label: `${r.label}${r.status === 'published' ? '' : '（未公开）'}`, value: r.count }))} /><List title="工具点击排行" rows={data.tools.map((r) => ({ label: r.label, value: r.count }))} /><List title="地区（访问次数 / 访客数）" rows={data.regions.map((r) => ({ label: r.label, value: `${r.visits} / ${r.visitors}` }))} /><List title="渠道（访问次数 / 访客数）" rows={data.channels.map((r) => ({ label: r.label, value: `${r.visits} / ${r.visitors}` }))} /></div>
    </>}
  </div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section className="border p-2"><h3 className="mb-2 font-semibold">{title}</h3>{children}</section>; }
function List({ title, rows }: { title: string; rows: { label: string; value: number | string }[] }) { return <Section title={title}>{rows.length ? <ul>{rows.map((row, index) => <li key={index} className="flex justify-between gap-2 border-t py-1"><span>{row.label}</span><span className="shrink-0 tabular-nums">{row.value}</span></li>)}</ul> : <p className="text-muted-foreground">暂无数据</p>}</Section>; }
