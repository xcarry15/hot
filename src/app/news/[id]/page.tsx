import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import PublicHeader from '@/components/public-header'
import PublicOriginalLink from '@/components/public-original-link'
import { ScoreBadge } from '@/components/ui/score-badge'
import { getTagToneClass } from '@/features/article-tag-style'
import { getPublicArticleDetail } from '@/lib/public-article-service'
import { getPublicSiteUrl } from '@/lib/public-site'
import { parseTags, splitBrands } from '@/lib/shared/article-codecs'

export const dynamic = 'force-dynamic'

function formatDate(value: string | null, fallback: string): string {
  const date = new Date(value || fallback)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(date)
}

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
  const article = await getPublicArticleDetail(id)
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
  const article = await getPublicArticleDetail(id, { recordView: true })
  if (!article) notFound()

  const tags = parseTags(article.tags)
  const brands = splitBrands(article.brand)
  const originalUrl = safeExternalUrl(article.url)

  return (
    <div className="min-h-[100dvh] bg-muted/20">
      <PublicHeader active="articles" />

      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <article className="rounded-lg border bg-background p-5 sm:p-8">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{formatDate(article.publishedAt, article.createdAt)}</span>
            <span className="text-border">|</span>
            <span>数据源：{article.source.name}</span>
            {article.originalSource && article.originalSource !== article.source.name && <><span className="text-border">|</span><span>原始来源：{article.originalSource}</span></>}
            {article.category && <><span className="text-border">|</span><span>{article.category}</span></>}
            <ScoreBadge score={article.score} />
          </div>

          <h1 className="mt-4 text-2xl font-bold leading-tight tracking-tight sm:text-3xl">{article.title}</h1>

          <div className="mt-4 flex flex-wrap gap-1.5">
            {brands.map((brand, index) => <Badge key={`${brand}-${index}`} variant="outline" className="rounded-none border-black bg-black text-white">{brand.trim()}</Badge>)}
            {tags.map((tag, index) => <Badge key={`${tag.name}-${index}`} variant="outline" className={`font-semibold ${getTagToneClass(tag.tone)}`}>{tag.name}</Badge>)}
          </div>

          {article.summary && <p className="mt-6 border-l-2 border-primary/50 pl-4 text-base leading-relaxed text-muted-foreground">{article.summary}</p>}

          {article.keyPoints.length > 0 && (
            <section className="mt-8">
              <h2 className="border-b pb-2 text-sm font-semibold text-muted-foreground">核心要点</h2>
              <ol className="mt-3 space-y-2 pl-5 text-sm leading-relaxed">
                {article.keyPoints.map((point, index) => <li key={`${point}-${index}`}>{point}</li>)}
              </ol>
            </section>
          )}

          {article.contentPreview && (
            <section className="mt-8">
              <h2 className="border-b pb-2 text-sm font-semibold text-muted-foreground">正文预览</h2>
              <p className="mt-3 whitespace-pre-line text-sm leading-7 text-muted-foreground">{article.contentPreview}{article.contentPreview.length >= 2000 ? '…' : ''}</p>
            </section>
          )}

          {originalUrl && (
            <div className="mt-8 border-t pt-5">
              <PublicOriginalLink href={originalUrl} articleId={article.id} />
            </div>
          )}
        </article>

        {article.related.length > 0 && (
          <section className="mt-5 rounded-lg border bg-background p-5 sm:p-6">
            <h2 className="text-sm font-semibold">相关动态</h2>
            <div className="mt-3 divide-y">
              {article.related.map((item) => <Link key={item.id} href={`/news/${item.id}`} className="flex items-center justify-between gap-4 py-3 text-sm hover:text-primary"><span className="line-clamp-2">{item.title}</span><span className="shrink-0 text-xs text-muted-foreground">{item.source.name}</span></Link>)}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
