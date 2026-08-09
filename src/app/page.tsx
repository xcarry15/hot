import type { Metadata } from 'next'
import { Suspense } from 'react'
import PublicErrorState from '@/components/public-error-state'
import PublicHomeSkeleton from '@/components/public-home-skeleton'
import PublicArticleFeed from '@/components/public-article-feed'
import PublicPageShell from '@/components/public-page-shell'
import { listPublicArticles } from '@/lib/public-article-service'
import { PUBLIC_SITE_NAME } from '@/lib/public-brand'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  const params = await searchParams
  const hasFilter = Boolean(first(params.q))
  return {
    title: hasFilter ? `资讯筛选 · ${PUBLIC_SITE_NAME}` : `行业资讯 · ${PUBLIC_SITE_NAME}`,
    description: '精选并聚合行业资讯，减少重复信息，帮助快速掌握行业动态。',
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
  const search = first(params.q)
  let data
  try {
    data = await listPublicArticles({ search })
  } catch {
    return <PublicErrorState />
  }
  const hasFilter = Boolean(search)

  return (
    <PublicPageShell active="articles" mainClassName="px-3 py-4 sm:px-6 sm:py-8">
      <PublicArticleFeed
        initialData={data}
        search={search}
        hasFilter={hasFilter}
      />
    </PublicPageShell>
  )
}
