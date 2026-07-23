import type { Metadata } from 'next'
import { Suspense } from 'react'
import PublicErrorState from '@/components/public-error-state'
import PublicHomeSkeleton from '@/components/public-home-skeleton'
import PublicArticleFeed from '@/components/public-article-feed'
import PublicFooter from '@/components/public-footer'
import PublicHeader from '@/components/public-header'
import { listPublicArticles } from '@/lib/public-article-service'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  const params = await searchParams
  const hasFilter = Boolean(first(params.q))
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
  const search = first(params.q)
  let data
  try {
    data = await listPublicArticles({ search })
  } catch {
    return <PublicErrorState />
  }
  const hasFilter = Boolean(search)

  return (
    <div className="public-site flex min-h-[100dvh] flex-col bg-background text-foreground">
      <PublicHeader active="articles" />

      <main className="mx-auto w-full max-w-[1200px] flex-1 px-3 py-4 sm:px-6 sm:py-8">
        <PublicArticleFeed
          initialData={data}
          search={search}
          hasFilter={hasFilter}
        />
      </main>

      <PublicFooter />
    </div>
  )
}
