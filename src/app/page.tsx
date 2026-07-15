import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import PublicArticleCard from '@/components/public-article-card'
import PublicHeader from '@/components/public-header'
import { listPublicArticles } from '@/lib/public-article-service'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

function buildPageHref(params: Record<string, string>, page: number): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value)
  }
  query.set('page', String(page))
  return `/?${query.toString()}`
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  const params = await searchParams
  const hasFilter = Boolean(first(params.q) || first(params.source) || first(params.from) || first(params.to) || Number(first(params.page)) > 1)
  return {
    title: hasFilter ? '文章筛选 · 行业新闻聚合' : '行业新闻聚合',
    description: '聚合行业动态，提供经过质量筛选的新闻文章。',
    alternates: { canonical: '/' },
    robots: hasFilter ? { index: false, follow: true } : { index: true, follow: true },
  }
}

export default async function PublicHomePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  const legacyTab = first(params.tab)
  if (legacyTab === 'settings' || legacyTab === 'crawl-log') {
    const detail = first(params.detail)
    redirect(`/admin?tab=${legacyTab}${detail ? `&detail=${encodeURIComponent(detail)}` : ''}`)
  }

  const search = first(params.q)
  const sourceId = first(params.source)
  const from = first(params.from)
  const to = first(params.to)
  const requestedPage = Math.max(1, Number(first(params.page)) || 1)
  const data = await listPublicArticles({ page: requestedPage, pageSize: 20, search, sourceId, from, to })
  const filterParams = { q: search, source: sourceId, from, to }
  const hasFilter = Boolean(search || sourceId || from || to)

  return (
    <div className="min-h-[100dvh] bg-muted/20">
      <PublicHeader active="articles" />

      <main className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-7">
        <div className="mb-4 flex flex-col gap-1">
          <h2 className="text-xl font-semibold tracking-tight">新闻卡片</h2>
          <p className="text-sm text-muted-foreground">按文章自身发布时间排序 · 自动公开门槛 {data.minScore} 分，人工公开可覆盖</p>
        </div>

        <form method="get" className="mb-5 flex flex-wrap items-center gap-2 rounded-md border bg-background p-3">
          <input
            name="q"
            defaultValue={search}
            placeholder="搜索标题、摘要或品牌"
            className="h-9 min-w-[220px] flex-1 rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
          />
          <select name="source" defaultValue={sourceId} className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="">全部数据源</option>
            {data.sources.map((source) => <option key={source.id} value={source.id}>{source.name}（{source.count}）</option>)}
          </select>
          <input name="from" type="date" defaultValue={from} aria-label="开始日期" className="h-9 rounded-md border bg-background px-2 text-sm" />
          <span className="text-xs text-muted-foreground">至</span>
          <input name="to" type="date" defaultValue={to} aria-label="结束日期" className="h-9 rounded-md border bg-background px-2 text-sm" />
          <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">筛选</button>
          {hasFilter && <Link href="/" className="px-2 text-sm text-muted-foreground hover:text-foreground">清除</Link>}
        </form>

        <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>共 {data.total} 篇</span>
          {data.totalPages > 1 && <span>第 {data.page}/{data.totalPages} 页</span>}
        </div>

        {data.items.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {data.items.map((article) => <PublicArticleCard key={article.id} article={article} />)}
          </div>
        ) : (
          <div className="rounded-md border bg-background px-6 py-16 text-center text-sm text-muted-foreground">暂无符合条件的文章</div>
        )}

        {data.totalPages > 1 && (
          <nav className="mt-6 flex items-center justify-center gap-2" aria-label="文章分页">
            {data.page > 1 ? <Link href={buildPageHref(filterParams, data.page - 1)} className="rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted">上一页</Link> : <span className="rounded-md border px-3 py-2 text-sm text-muted-foreground/50">上一页</span>}
            <span className="px-2 text-sm text-muted-foreground">{data.page} / {data.totalPages}</span>
            {data.page < data.totalPages ? <Link href={buildPageHref(filterParams, data.page + 1)} className="rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted">下一页</Link> : <span className="rounded-md border px-3 py-2 text-sm text-muted-foreground/50">下一页</span>}
          </nav>
        )}
      </main>
    </div>
  )
}
