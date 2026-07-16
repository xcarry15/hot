'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import PublicArticleTimeline from '@/components/public-article-timeline'
import type {
  PublicArticleDateGroupDto,
  PublicArticleSourceOptionDto,
  PublicArticleListResponseDto,
} from '@/contracts/public-articles'

const LOAD_MORE_DATE_LIMIT = 3
const SEARCH_INITIAL_DATE_LIMIT = 10
const INITIAL_DATE_LIMIT = 3

type Props = {
  initialData: PublicArticleListResponseDto
  search: string
  sourceId: string
  from: string
  to: string
  hasFilter: boolean
  sourceOptions: PublicArticleSourceOptionDto[]
}

function buildFeedUrl(params: {
  search: string
  sourceId: string
  from: string
  to: string
  before?: string | null
  dateLimit?: number
  probe?: boolean
}): string {
  const query = new URLSearchParams()
  if (params.search) query.set('q', params.search)
  if (params.sourceId) query.set('source', params.sourceId)
  if (params.from) query.set('from', params.from)
  if (params.to) query.set('to', params.to)
  if (params.before) query.set('before', params.before)
  if (params.dateLimit) query.set('dateLimit', String(params.dateLimit))
  if (params.probe) query.set('probe', '1')
  return `/api/public/articles?${query.toString()}`
}

function countGroupItems(groups: PublicArticleDateGroupDto[]): number {
  return groups.reduce((total, group) => total + group.items.length, 0)
}

function mergeGroups(
  current: PublicArticleDateGroupDto[],
  incoming: PublicArticleDateGroupDto[],
): PublicArticleDateGroupDto[] {
  const groups = new Map(current.map((group) => [group.date, group]))
  for (const group of incoming) groups.set(group.date, group)
  return [...groups.values()].sort((a, b) => b.date.localeCompare(a.date))
}

function createState(
  data: PublicArticleListResponseDto,
  groups = data.groups,
): PublicArticleListResponseDto {
  return {
    ...data,
    groups,
    items: groups.flatMap((group) => group.items),
    displayedArticleCount: countGroupItems(groups),
    displayedDateCount: groups.length,
  }
}

function mergeLatestState(
  current: PublicArticleListResponseDto,
  data: PublicArticleListResponseDto,
): PublicArticleListResponseDto {
  const groups = mergeGroups(current.groups, data.groups)
  const hasLoadedOlderGroups = current.displayedDateCount > data.displayedDateCount

  return createState({
    ...data,
    nextDate: hasLoadedOlderGroups ? current.nextDate : data.nextDate,
    hasMore: hasLoadedOlderGroups ? current.hasMore : data.hasMore,
  }, groups)
}

async function requestFeed(url: string): Promise<PublicArticleListResponseDto> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error('加载文章失败')
  return response.json() as Promise<PublicArticleListResponseDto>
}

export default function PublicArticleFeed({
  initialData,
  search,
  sourceId,
  from,
  to,
  hasFilter,
  sourceOptions,
}: Props) {
  const [state, setState] = useState(initialData)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [hasNewArticles, setHasNewArticles] = useState(false)
  const feedIdentity = useMemo(() => [search, sourceId, from, to].join('|'), [search, sourceId, from, to])
  const previousIdentity = useRef(feedIdentity)
  const initialDateLimit = search ? SEARCH_INITIAL_DATE_LIMIT : INITIAL_DATE_LIMIT

  useEffect(() => {
    if (previousIdentity.current === feedIdentity) return
    previousIdentity.current = feedIdentity
    setState(initialData)
    setLoadError(false)
    setHasNewArticles(false)
  }, [feedIdentity, initialData])

  useEffect(() => {
    let cancelled = false

    async function checkForNewArticles() {
      if (document.visibilityState === 'hidden') return
      try {
        const response = await fetch(buildFeedUrl({ search, sourceId, from, to, probe: true }), {
          cache: 'no-store',
        })
        if (!response.ok || cancelled) return
        const revision = await response.json() as { total?: number }
        if (typeof revision.total === 'number' && revision.total > state.total) {
          setHasNewArticles(true)
        }
      } catch {
        // 轮询失败不打断当前阅读，下一轮继续检查。
      }
    }

    const timer = window.setInterval(checkForNewArticles, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [feedIdentity, from, search, sourceId, state.total, to])

  async function loadMore() {
    if (loading || !state.hasMore || !state.nextDate) return
    setLoading(true)
    setLoadError(false)
    try {
      const data = await requestFeed(buildFeedUrl({
        search,
        sourceId,
        from,
        to,
        before: state.nextDate,
        dateLimit: LOAD_MORE_DATE_LIMIT,
      }))
      setState((current) => createState(data, mergeGroups(current.groups, data.groups)))
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  async function refreshLatest() {
    if (refreshing) return
    setRefreshing(true)
    try {
      const data = await requestFeed(buildFeedUrl({
        search,
        sourceId,
        from,
        to,
        dateLimit: initialDateLimit,
      }))
      setState((current) => mergeLatestState(current, data))
      setHasNewArticles(false)
    } catch {
      setLoadError(true)
    } finally {
      setRefreshing(false)
    }
  }

  const summary = hasFilter ? `找到 ${state.total} 篇` : `共 ${state.total} 篇`

  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-4">
        <h1 className="public-display shrink-0 text-3xl leading-tight text-[var(--public-ink)] sm:text-4xl">文章列表</h1>
        <form method="get" className="flex min-w-0 max-w-[760px] flex-1 flex-wrap items-center justify-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">搜索文章</span>
            <input
              name="q"
              defaultValue={search}
              placeholder="搜索标题、摘要或品牌"
              className="h-9 w-full rounded-none border border-[var(--public-hairline)] bg-transparent px-3 text-sm text-[var(--public-ink)] outline-none transition-[border-color,box-shadow] placeholder:text-[var(--public-muted-soft)] focus:border-[var(--public-primary)] focus:ring-4 focus:ring-[color:rgb(204_120_92_/_0.15)]"
            />
          </label>
          <label className="sr-only" htmlFor="public-source-filter">数据源</label>
          <select id="public-source-filter" name="source" defaultValue={sourceId} className="h-9 max-w-[150px] border border-[var(--public-hairline)] bg-transparent px-2 text-xs text-[var(--public-ink)] outline-none focus:border-[var(--public-primary)]">
            <option value="">全部来源</option>
            {sourceOptions.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
          </select>
          <label className="sr-only" htmlFor="public-from-filter">开始日期</label>
          <input id="public-from-filter" type="date" name="from" defaultValue={from} className="h-9 border border-[var(--public-hairline)] bg-transparent px-2 text-xs text-[var(--public-ink)] outline-none focus:border-[var(--public-primary)]" />
          <label className="sr-only" htmlFor="public-to-filter">结束日期</label>
          <input id="public-to-filter" type="date" name="to" defaultValue={to} className="h-9 border border-[var(--public-hairline)] bg-transparent px-2 text-xs text-[var(--public-ink)] outline-none focus:border-[var(--public-primary)]" />
          <button type="submit" className="h-9 shrink-0 rounded-none bg-[var(--public-primary)] px-4 text-sm font-medium text-white transition-[background-color,transform] hover:bg-[var(--public-primary-active)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color:rgb(204_120_92_/_0.25)] active:translate-y-px motion-reduce:transition-none">搜索</button>
          {hasFilter && <Link href="/" className="shrink-0 px-1 text-sm text-[var(--public-muted)] underline-offset-4 transition-colors hover:text-[var(--public-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]">清除</Link>}
        </form>
      </div>

      {hasNewArticles && (
        <div className="mb-5 flex items-center justify-between gap-3 border border-[var(--public-primary)] bg-[var(--public-surface-soft)] px-4 py-3 text-sm text-[var(--public-primary)]" role="status">
          <span>有新文章可查看</span>
          <button type="button" onClick={refreshLatest} disabled={refreshing} className="shrink-0 font-medium underline underline-offset-4 disabled:opacity-60">
            {refreshing ? '刷新中…' : '刷新最新文章'}
          </button>
        </div>
      )}

      {state.groups.length > 0 ? (
        <PublicArticleTimeline key={feedIdentity} groups={state.groups} />
      ) : (
        <div className="rounded-xl border border-[var(--public-hairline)] bg-[var(--public-surface)] px-6 py-16 text-center">
          <p className="public-display text-2xl text-[var(--public-ink)]">{hasFilter ? '没有找到匹配文章' : '暂时没有公开文章'}</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-7 text-[var(--public-muted)]">{hasFilter ? '可以尝试放宽关键词、数据源或日期范围。' : '符合公开条件的文章将在这里按日期整理。'}</p>
          {hasFilter && <Link href="/" className="mt-5 inline-flex h-10 items-center rounded-md border border-[var(--public-hairline-strong)] px-4 text-sm font-medium text-[var(--public-ink)] transition-colors hover:border-[var(--public-primary)] hover:text-[var(--public-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]">清除筛选</Link>}
        </div>
      )}

      {state.groups.length > 0 && (
        <div className="mt-10 flex flex-col items-center gap-3">
          {state.hasMore ? (
            <>
              <p className="text-sm text-[var(--public-muted)]" aria-live="polite">{summary}</p>
              <button type="button" onClick={loadMore} disabled={loading} className="h-10 rounded-none border border-[var(--public-hairline-strong)] px-5 text-sm font-medium text-[var(--public-ink)] transition-colors hover:border-[var(--public-primary)] hover:text-[var(--public-primary)] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]">
                {loading ? '加载中…' : loadError ? '加载失败，点击重试' : '加载更早日期'}
              </button>
            </>
          ) : (
            <p className="text-xs text-[var(--public-muted-soft)]" role="status">{summary} · 已全部加载</p>
          )}
        </div>
      )}
    </>
  )
}
