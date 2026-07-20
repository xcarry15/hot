'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import PublicArticleTimeline from '@/components/public-article-timeline'
import type {
  PublicArticleDateGroupDto,
  PublicArticleListResponseDto,
} from '@/contracts/public-articles'

type Props = {
  initialData: PublicArticleListResponseDto
  search: string
  hasFilter: boolean
}

function buildFeedUrl(params: {
  search: string
  cursor?: string | null
  probe?: boolean
}): string {
  const query = new URLSearchParams()
  if (params.search) query.set('q', params.search)
  if (params.cursor) query.set('cursor', params.cursor)
  if (params.probe) query.set('probe', '1')
  return `/api/public/articles?${query.toString()}`
}

function countGroupItems(groups: PublicArticleDateGroupDto[]): number {
  return groups.reduce((total, group) => total + group.items.length, 0)
}

function mergeGroups(
  current: PublicArticleDateGroupDto[],
  incoming: PublicArticleDateGroupDto[],
  incomingFirst = false,
): PublicArticleDateGroupDto[] {
  const groups = new Map(current.map((group) => [group.date, group]))
  for (const group of incoming) {
    const existing = groups.get(group.date)
    if (!existing) {
      groups.set(group.date, group)
      continue
    }
    const orderedItems = incomingFirst
      ? [...group.items, ...existing.items]
      : [...existing.items, ...group.items]
    const items = new Map(orderedItems.map((item) => [item.id, item]))
    groups.set(group.date, { ...group, count: items.size, items: [...items.values()] })
  }
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
  const groups = mergeGroups(current.groups, data.groups, true)
  const hasLoadedOlderArticles = current.displayedArticleCount > data.displayedArticleCount

  return createState({
    ...data,
    nextCursor: hasLoadedOlderArticles ? current.nextCursor : data.nextCursor,
    hasMore: hasLoadedOlderArticles ? current.hasMore : data.hasMore,
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
  hasFilter,
}: Props) {
  const [state, setState] = useState(initialData)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [hasNewArticles, setHasNewArticles] = useState(false)
  const feedIdentity = useMemo(() => search, [search])
  const previousIdentity = useRef(feedIdentity)
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
        const response = await fetch(buildFeedUrl({ search, probe: true }), {
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
  }, [feedIdentity, search, state.total])

  async function loadMore() {
    if (loading || !state.hasMore || !state.nextCursor) return
    setLoading(true)
    setLoadError(false)
    try {
      const data = await requestFeed(buildFeedUrl({
        search,
        cursor: state.nextCursor,
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
      }))
      setState((current) => mergeLatestState(current, data))
      setHasNewArticles(false)
    } catch {
      setLoadError(true)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <>
      <div className="public-section-enter mb-5 flex items-center justify-between gap-4">
        <h1 className="public-display shrink-0 text-3xl leading-tight text-[var(--public-ink)] sm:text-4xl">文章列表</h1>
        <form method="get" className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <label className="w-[220px] min-w-0 sm:w-[280px]">
            <span className="sr-only">搜索文章</span>
            <input
              name="q"
              defaultValue={search}
              placeholder="搜索标题、摘要或品牌"
              className="h-9 w-full rounded-none border border-[var(--public-hairline)] bg-transparent px-3 text-sm text-[var(--public-ink)] outline-none transition-[border-color,box-shadow] placeholder:text-[var(--public-muted-soft)] focus:border-[var(--public-primary)] focus:ring-4 focus:ring-[color:rgb(204_120_92_/_0.15)]"
            />
          </label>
          <button type="submit" className="public-pressable h-9 shrink-0 rounded-none bg-[var(--public-primary)] px-4 text-sm font-medium text-white transition-colors hover:bg-[var(--public-primary-active)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color:rgb(204_120_92_/_0.25)]">搜索</button>
          {hasFilter && <Link href="/" className="shrink-0 px-1 text-sm text-[var(--public-muted)] underline-offset-4 transition-colors hover:text-[var(--public-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]">清除</Link>}
        </form>
      </div>

      {hasNewArticles && (
        <div className="public-notice-enter mb-5 flex items-center justify-between gap-3 border border-[var(--public-primary)] bg-[var(--public-surface-soft)] px-4 py-3 text-sm text-[var(--public-primary)]" role="status">
          <span>有新文章可查看</span>
          <button type="button" onClick={refreshLatest} disabled={refreshing} className="public-pressable shrink-0 font-medium underline underline-offset-4 disabled:opacity-60">
            {refreshing ? '刷新中…' : '刷新最新文章'}
          </button>
        </div>
      )}

      {state.groups.length > 0 ? (
        <PublicArticleTimeline key={feedIdentity} groups={state.groups} />
      ) : (
        <div className="public-section-enter border border-[var(--public-hairline)] bg-[var(--public-surface)] px-6 py-16 text-center">
          <p className="public-display text-2xl text-[var(--public-ink)]">{hasFilter ? '没有找到匹配文章' : '暂时没有公开文章'}</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-7 text-[var(--public-muted)]">{hasFilter ? '可以尝试更换或缩短搜索关键词。' : '符合公开条件的文章将在这里按日期整理。'}</p>
          {hasFilter && <Link href="/" className="public-pressable mt-5 inline-flex h-10 items-center border border-[var(--public-hairline-strong)] px-4 text-sm font-medium text-[var(--public-ink)] transition-colors hover:border-[var(--public-primary)] hover:text-[var(--public-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]">清除筛选</Link>}
        </div>
      )}

      {state.groups.length > 0 && (
        <div className="mt-10 flex justify-center">
          {state.hasMore ? (
            <button type="button" onClick={loadMore} disabled={loading} className="public-pressable h-10 rounded-none border border-[var(--public-hairline-strong)] px-5 text-sm font-medium text-[var(--public-ink)] transition-colors hover:border-[var(--public-primary)] hover:text-[var(--public-primary)] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]">
              {loading ? '加载中…' : loadError ? '加载失败，点击重试' : '加载更多'}
            </button>
          ) : (
            <span className="sr-only" role="status">已全部加载</span>
          )}
        </div>
      )}
    </>
  )
}
