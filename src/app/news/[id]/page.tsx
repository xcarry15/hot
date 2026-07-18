import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import PublicErrorState from '@/components/public-error-state'
import PublicFooter from '@/components/public-footer'
import PublicHeader from '@/components/public-header'
import PublicOriginalLink, { PublicShareButton } from '@/components/public-original-link'
import { ScoreBadge } from '@/components/ui/score-badge'
import { getTagToneClass } from '@/features/article-tag-style'
import { getPublicArticleDetail } from '@/lib/public-article-service'
import { getPublicSiteUrl } from '@/lib/public-site'
import { parseTags, splitBrands } from '@/lib/shared/article-codecs'
import { formatPublicDateTime, formatPublicTime } from '@/lib/shared/public-date'

export const dynamic = 'force-dynamic'

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  let article
  try {
    article = await getPublicArticleDetail(id)
  } catch {
    return { title: '文章暂时不可用 · 行业新闻聚合', robots: { index: false, follow: false } }
  }
  if (!article) return { title: '文章不存在 · 行业新闻聚合', robots: { index: false, follow: false } }
  const description = article.summary || article.excerpt
  const canonical = `/news/${article.id}`
  return {
    title: `${article.title} · 行业新闻聚合`,
    description: description.slice(0, 160),
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: {
      type: 'article',
      url: new URL(canonical, getPublicSiteUrl()).toString(),
      title: article.title,
      description: description.slice(0, 160),
      siteName: '行业新闻聚合',
      publishedTime: article.publishedAt ?? article.createdAt,
      authors: [article.source.name],
    },
  }
}

export default async function PublicNewsDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let article
  try {
    article = await getPublicArticleDetail(id, { recordView: true })
  } catch {
    return <PublicErrorState detail />
  }
  if (!article) notFound()

  const tags = parseTags(article.tags)
  const brands = splitBrands(article.brand)
  const originalUrl = safeExternalUrl(article.url)
  const effectiveDate = article.publishedAt || article.createdAt
  const hasSummary = Boolean(article.summary)
  const hasKeyPoints = article.keyPoints.length > 0

  return (
    <div className="public-site flex min-h-[100dvh] flex-col bg-background text-foreground">
      <PublicHeader active="articles" />

      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <div className="mx-auto max-w-[840px]">
          <Link href="/" className="inline-flex items-center text-sm text-[var(--public-muted)] underline-offset-4 transition-colors hover:text-[var(--public-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]">
            ← 返回文章列表
          </Link>

          <article className="mt-3 bg-[var(--public-canvas)] px-0 pt-3 pb-5 sm:mt-3 sm:px-8 sm:pt-4 sm:pb-7">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--public-muted)]">
              <time dateTime={effectiveDate}>{formatPublicDateTime(effectiveDate)}</time>
              <span className="text-[var(--public-hairline-strong)]">|</span>
              <span>{article.source.name}</span>
              {article.originalSource && article.originalSource !== article.source.name && <><span className="text-[var(--public-hairline-strong)]">|</span><span>原始来源：{article.originalSource}</span></>}
              {article.category && <><span className="text-[var(--public-hairline-strong)]">|</span><span>{article.category}</span></>}
              {article.sourceCount > 1 && <><span className="text-[var(--public-hairline-strong)]">|</span><span>{article.sourceCount} 个来源</span></>}
              {originalUrl && <div className="ml-auto"><PublicOriginalLink href={originalUrl} articleId={article.id} shareUrl={`${getPublicSiteUrl()}/news/${article.id}`} /></div>}
            </div>

            <h1 className="public-display mt-2 text-3xl leading-[1.25] text-[var(--public-ink)] sm:mt-2 sm:text-4xl">{article.title}</h1>

            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
              <span aria-label={`评分 ${article.score} 分`} className="inline-flex shrink-0 items-center"><ScoreBadge score={article.score} variant="compact-square-wide" /></span>
              {brands.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {brands.map((brand, index) => <Badge key={`${brand}-${index}`} variant="outline" className="rounded-none border-[var(--public-ink)] bg-[var(--public-ink)] px-2 py-0.5 text-white">{brand.trim()}</Badge>)}
                </div>
              )}
              {tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
                  {tags.map((tag, index) => <Badge key={`${tag.name}-${index}`} variant="outline" className={`rounded-none px-0 py-0 text-sm font-semibold ${getTagToneClass(tag.tone)}`}>{tag.name}</Badge>)}
                </div>
              )}
            </div>

            {(hasSummary || hasKeyPoints) && (
              <div className="mt-6 grid gap-4 border-t border-[var(--public-hairline)] pt-5 md:grid-cols-2 md:gap-5">
                {hasKeyPoints && (
                  <section className={!hasSummary ? 'md:col-span-2' : ''}>
                    <div className="h-full bg-[var(--public-surface-soft)] px-4 py-4 sm:px-5 sm:py-5">
                      <h2 className="text-sm font-semibold text-[var(--public-primary)]">核心要点</h2>
                      <ol className="mt-3 list-decimal space-y-2 pl-6 text-[15px] leading-7 text-[var(--public-body)] marker:font-semibold marker:text-[var(--public-primary)]">
                        {article.keyPoints.map((point, index) => <li key={`${point}-${index}`}>{point}</li>)}
                      </ol>
                    </div>
                  </section>
                )}

                {hasSummary && (
                  <section className={!hasKeyPoints ? 'md:col-span-2' : ''}>
                    <div className="h-full bg-[var(--public-surface-soft)] px-4 py-4 sm:px-5 sm:py-5">
                      <h2 className="text-sm font-semibold text-[var(--public-primary)]">AI洞察</h2>
                      <p className="mt-3 border-l-2 border-[var(--public-primary)] pl-3 text-[15px] leading-7 text-[var(--public-body)] sm:leading-8">{article.summary}</p>
                    </div>
                  </section>
                )}
              </div>
            )}

            <div className="mt-7 flex justify-center pt-2">
              <PublicShareButton shareUrl={`${getPublicSiteUrl()}/news/${article.id}`} title={article.title} summary={article.summary || article.excerpt} publishedAt={formatPublicDateTime(effectiveDate)} />
            </div>

            {article.sources.length > 1 && (
              <section className="mt-7 border-t border-[var(--public-hairline)] pt-5" aria-labelledby="event-sources-title">
                <h2 id="event-sources-title" className="text-sm font-semibold text-[var(--public-primary)]">其他报道来源</h2>
                <ul className="mt-3 space-y-2 text-sm">
                  {article.sources.map((item) => (
                    <li key={item.id} className="flex items-start justify-between gap-4 border-b border-[var(--public-hairline)] pb-2">
                      <div className="min-w-0"><a href={item.url} target="_blank" rel="noreferrer" className="line-clamp-2 text-[var(--public-body)] hover:text-[var(--public-primary)] hover:underline">{item.title}</a><p className="mt-1 text-xs text-[var(--public-muted)]">{item.source.name}</p></div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <nav className="mt-5 border-t border-[var(--public-hairline)] pt-4" aria-label="文章导航">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                {article.navigation.previous && (
                  <Link href={`/news/${article.navigation.previous.id}`} className="group/navigation flex w-full min-w-0 items-center gap-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] sm:flex-1 sm:basis-0">
                    <span className="shrink-0 text-xs text-[var(--public-muted-soft)]">上一篇：</span>
                    <span className="truncate text-[var(--public-body)] transition-colors group-hover/navigation:text-[var(--public-primary)]">{article.navigation.previous.title}</span>
                  </Link>
                )}
                {article.navigation.next && (
                  <Link href={`/news/${article.navigation.next.id}`} className="group/navigation flex w-full min-w-0 items-center gap-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] sm:flex-1 sm:basis-0 sm:justify-end">
                    <span className="shrink-0 text-xs text-[var(--public-muted-soft)]">下一篇：</span>
                    <span className="truncate text-[var(--public-body)] transition-colors group-hover/navigation:text-[var(--public-primary)]">{article.navigation.next.title}</span>
                  </Link>
                )}
              </div>
            </nav>
          </article>

          {article.related.length > 0 && (
            <section className="mt-8" aria-labelledby="related-articles-title">
              <div className="flex items-end justify-between gap-4 border-b border-[var(--public-hairline)] pb-3">
                <h2 id="related-articles-title" className="public-display text-2xl text-[var(--public-ink)]">相关文章</h2>
                <span className="text-xs text-[var(--public-muted)]">{article.related.length} 篇</span>
              </div>
              <ol className="mt-1">
                {article.related.map((item) => {
                  const itemDate = item.publishedAt || item.createdAt
                  return (
                    <li key={item.id}>
                      <Link href={`/news/${item.id}`} className="group/related grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)] sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-3">
                        <time dateTime={itemDate} className="pt-2 text-right font-mono text-xs tabular-nums text-[var(--public-muted)]">{formatPublicTime(itemDate)}</time>
                        <div className="border-l border-[var(--public-hairline)] pb-1 pl-3 sm:pl-4">
                          <div className="block rounded-none border border-transparent bg-transparent px-2 py-2 transition-[background-color,border-color,transform] duration-200 group-hover/related:-translate-y-px group-hover/related:border-[var(--public-hairline-strong)] group-hover/related:bg-[var(--public-surface-soft)] motion-reduce:transition-none motion-reduce:group-hover/related:transform-none">
                          <div className="flex items-start justify-between gap-3">
                            <span className="line-clamp-2 text-sm font-medium leading-6 text-[var(--public-ink)]">{item.title}</span>
                            <ScoreBadge score={item.score} variant="compact-square" />
                          </div>
                          </div>
                        </div>
                      </Link>
                    </li>
                  )
                })}
              </ol>
            </section>
          )}
        </div>
      </main>

      <PublicFooter />
    </div>
  )
}
