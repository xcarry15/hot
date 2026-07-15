import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import PublicErrorState from '@/components/public-error-state'
import PublicHomeSkeleton from '@/components/public-home-skeleton'
import PublicArticleTimeline from '@/components/public-article-timeline'
import PublicFooter from '@/components/public-footer'
import PublicHeader from '@/components/public-header'
import { listPublicArticles } from '@/lib/public-article-service'
import { formatPublicDateRange } from '@/lib/shared/public-date'

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

export default function PublicHomePage(props: { searchParams: Promise<SearchParams> }) {
  return (
    <Suspense fallback={<PublicHomeSkeleton />}>
      <PublicHomeContent {...props} />
    </Suspense>
  )
}

async function PublicHomeContent({ searchParams }: { searchParams: Promise<SearchParams> }) {
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
  let data
  try {
    data = await listPublicArticles({ page: requestedPage, pageSize: 20, search, sourceId, from, to })
  } catch {
    return <PublicErrorState />
  }
  const filterParams = { q: search, source: sourceId, from, to }
  const hasFilter = Boolean(search || sourceId || from || to)

  return (
    <div className="public-site flex min-h-[100dvh] flex-col bg-background text-foreground">
      <PublicHeader active="articles" />

      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-5 sm:px-6 sm:py-8">
        <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-baseline gap-3">
            <h1 className="public-display text-3xl leading-tight text-[var(--public-ink)] sm:text-4xl">文章列表</h1>
            <span className="text-sm text-[var(--public-muted)]">共 {data.total} 篇</span>
          </div>
          <form method="get" className="flex w-full items-center gap-2 sm:w-auto">
            <label className="min-w-0 flex-1 sm:w-[260px] sm:flex-none">
              <span className="sr-only">搜索文章</span>
              <input
                name="q"
                defaultValue={search}
                placeholder="搜索标题、摘要或品牌"
                className="h-10 w-full rounded-none border border-[var(--public-hairline)] bg-transparent px-3 text-sm text-[var(--public-ink)] outline-none transition-[border-color,box-shadow] placeholder:text-[var(--public-muted-soft)] focus:border-[var(--public-primary)] focus:ring-4 focus:ring-[color:rgb(204_120_92_/_0.15)]"
              />
            </label>
            <button type="submit" className="h-10 shrink-0 rounded-none bg-[var(--public-primary)] px-5 text-sm font-medium text-white transition-[background-color,transform] hover:bg-[var(--public-primary-active)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color:rgb(204_120_92_/_0.25)] active:translate-y-px motion-reduce:transition-none">搜索</button>
            {hasFilter && <Link href="/" className="shrink-0 px-1 text-sm text-[var(--public-muted)] underline-offset-4 transition-colors hover:text-[var(--public-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]">清除</Link>}
          </form>
        </div>

        {data.totalPages > 1 && (
          <div className="mb-5 flex flex-wrap items-center justify-end gap-2 text-xs text-[var(--public-muted)]">
            <span>第 {data.page}/{data.totalPages} 页 · {formatPublicDateRange(data.pageStartDate, data.pageEndDate)}</span>
          </div>
        )}

        {data.groups.length > 0 ? (
          <PublicArticleTimeline groups={data.groups} />
        ) : (
          <div className="rounded-xl border border-[var(--public-hairline)] bg-[var(--public-surface)] px-6 py-16 text-center">
            <p className="public-display text-2xl text-[var(--public-ink)]">{hasFilter ? '没有找到匹配文章' : '暂时没有公开文章'}</p>
            <p className="mx-auto mt-2 max-w-md text-sm leading-7 text-[var(--public-muted)]">{hasFilter ? '可以尝试放宽关键词、数据源或日期范围。' : '符合公开条件的文章将在这里按日期整理。'}</p>
            {hasFilter && <Link href="/" className="mt-5 inline-flex h-10 items-center rounded-md border border-[var(--public-hairline-strong)] px-4 text-sm font-medium text-[var(--public-ink)] transition-colors hover:border-[var(--public-primary)] hover:text-[var(--public-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]">清除筛选</Link>}
          </div>
        )}

        {data.totalPages > 1 && (
          <nav className="mt-10 flex items-center justify-center gap-3" aria-label="文章分页">
            {data.page > 1 ? <Link href={buildPageHref(filterParams, data.page - 1)} className="rounded-md border border-[var(--public-hairline)] bg-[var(--public-surface)] px-4 py-2.5 text-sm text-[var(--public-ink)] transition-colors hover:border-[var(--public-primary)] hover:text-[var(--public-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]">上一页</Link> : <span className="rounded-md border border-[var(--public-hairline)] px-4 py-2.5 text-sm text-[var(--public-muted-soft)]">上一页</span>}
            <span className="px-2 text-center text-xs leading-5 text-[var(--public-muted)]">第 {data.page} / {data.totalPages} 页</span>
            {data.page < data.totalPages ? <Link href={buildPageHref(filterParams, data.page + 1)} className="rounded-md border border-[var(--public-hairline)] bg-[var(--public-surface)] px-4 py-2.5 text-sm text-[var(--public-ink)] transition-colors hover:border-[var(--public-primary)] hover:text-[var(--public-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]">下一页</Link> : <span className="rounded-md border border-[var(--public-hairline)] px-4 py-2.5 text-sm text-[var(--public-muted-soft)]">下一页</span>}
          </nav>
        )}
      </main>

      <PublicFooter />
    </div>
  )
}
