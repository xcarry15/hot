import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import PublicErrorState from '@/components/public-error-state'
import PublicFooter from '@/components/public-footer'
import PublicHeader from '@/components/public-header'
import PublicOriginalLink from '@/components/public-original-link'
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

  return (
    <div className="public-site flex min-h-[100dvh] flex-col bg-background text-foreground">
      <PublicHeader active="articles" />

      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-7 sm:px-6 sm:py-12">
        <div className="mx-auto max-w-[820px]">
          <Link href="/" className="inline-flex items-center text-sm text-[var(--public-muted)] underline-offset-4 transition-colors hover:text-[var(--public-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]">
            ← 返回文章列表
          </Link>

          <article className="mt-5 bg-[var(--public-canvas)] px-0 py-7 sm:px-8 sm:py-9">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--public-muted)]">
              <time dateTime={effectiveDate}>{formatPublicDateTime(effectiveDate)}</time>
              <span className="text-[var(--public-hairline-strong)]">|</span>
              <span>数据源：{article.source.name}</span>
              {article.originalSource && article.originalSource !== article.source.name && <><span className="text-[var(--public-hairline-strong)]">|</span><span>原始来源：{article.originalSource}</span></>}
              {article.category && <><span className="text-[var(--public-hairline-strong)]">|</span><span>{article.category}</span></>}
              <span aria-label={`评分 ${article.score} 分`} className="flex items-center"><ScoreBadge score={article.score} variant="compact-square" /></span>
            </div>

            <h1 className="public-display mt-5 text-3xl leading-tight text-[var(--public-ink)] sm:text-4xl">{article.title}</h1>

            <div className="mt-5 flex flex-wrap gap-1.5">
              {brands.map((brand, index) => <Badge key={`${brand}-${index}`} variant="outline" className="rounded-none border-[var(--public-ink)] bg-[var(--public-ink)] text-white">{brand.trim()}</Badge>)}
              {tags.map((tag, index) => <Badge key={`${tag.name}-${index}`} variant="outline" className={`font-semibold ${getTagToneClass(tag.tone)}`}>{tag.name}</Badge>)}
            </div>

            {article.summary && (
              <section className="mt-8 border-t border-[var(--public-hairline)] pt-6">
                <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--public-primary)]">AI洞察</h2>
                <p className="mt-4 border-l-2 border-[var(--public-primary)] pl-4 text-base leading-8 text-[var(--public-body)]">{article.summary}</p>
              </section>
            )}

            {article.keyPoints.length > 0 && (
              <section className="mt-8 border-t border-[var(--public-hairline)] pt-6">
                <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--public-primary)]">核心要点</h2>
                <ol className="mt-4 list-decimal space-y-3 pl-7 text-sm leading-7 text-[var(--public-body)] marker:font-semibold marker:text-[var(--public-primary)]">
                  {article.keyPoints.map((point, index) => <li key={`${point}-${index}`}>{point}</li>)}
                </ol>
              </section>
            )}

            {article.contentPreview && (
              <section className="mt-8 border-t border-[var(--public-hairline)] pt-6">
                <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--public-primary)]">正文预览</h2>
                <p className="mt-4 line-clamp-5 whitespace-pre-line text-sm leading-8 text-[var(--public-body)] sm:line-clamp-8">{article.contentPreview}</p>
              </section>
            )}

            {originalUrl && (
              <div className="mt-7 border-t border-[var(--public-hairline)] pt-5">
                <PublicOriginalLink href={originalUrl} articleId={article.id} />
              </div>
            )}
          </article>

          {article.related.length > 0 && (
            <section className="mt-10" aria-labelledby="related-articles-title">
              <div className="flex items-end justify-between gap-4 border-b border-[var(--public-hairline)] pb-3">
                <h2 id="related-articles-title" className="public-display text-2xl text-[var(--public-ink)]">相关文章</h2>
                <span className="text-xs text-[var(--public-muted)]">{article.related.length} 篇</span>
              </div>
              <ol className="mt-2">
                {article.related.map((item) => {
                  const itemDate = item.publishedAt || item.createdAt
                  return (
                    <li key={item.id}>
                      <Link href={`/news/${item.id}`} className="group/related grid grid-cols-[4rem_minmax(0,1fr)] gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)] sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-5">
                        <time dateTime={itemDate} className="pt-4 text-right font-mono text-xs tabular-nums text-[var(--public-muted)]">{formatPublicTime(itemDate)}</time>
                        <div className="border-l border-[var(--public-hairline)] pb-2 pl-4 sm:pl-6">
                          <div className="block rounded-none border border-transparent bg-transparent px-4 py-4 transition-[background-color,border-color,transform] duration-200 group-hover/related:-translate-y-px group-hover/related:border-[var(--public-hairline-strong)] group-hover/related:bg-[var(--public-surface-soft)] motion-reduce:transition-none motion-reduce:group-hover/related:transform-none">
                          <div className="flex items-start justify-between gap-4">
                            <span className="line-clamp-2 text-sm font-medium leading-7 text-[var(--public-ink)]">{item.title}</span>
                            <ScoreBadge score={item.score} variant="compact-square" />
                          </div>
                          <span className="mt-1 block text-xs text-[var(--public-muted)]">数据源：{item.source.name}</span>
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
