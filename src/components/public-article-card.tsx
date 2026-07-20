import Link from 'next/link'
import { parseTags, splitBrands } from '@/lib/shared/article-codecs'
import { getTagToneClass } from '@/features/article-tag-style'
import { ScoreBadge } from '@/components/ui/score-badge'
import type { PublicArticleListItemDto } from '@/contracts/public-articles'
import { formatPublicTime } from '@/lib/shared/public-date'
import type { CSSProperties } from 'react'

type PublicArticleMetaItem = {
  label: string
  kind: 'brand' | 'tag' | 'meta'
  className: string
}

export default function PublicArticleCard({
  article,
  revealIndex = 0,
}: {
  article: PublicArticleListItemDto
  revealIndex?: number
}) {
  const tags = parseTags(article.tags)
  const brands = splitBrands(article.brand)
  const effectiveDate = article.publishedAt || article.createdAt
  const brandItems: PublicArticleMetaItem[] = brands
    .map((brand) => ({ label: brand.trim(), kind: 'brand' as const, className: '' }))
    .filter((item) => item.label)
  const tagItems: PublicArticleMetaItem[] = tags.map((tag) => ({
    label: tag.name,
    kind: 'tag' as const,
    className: getTagToneClass(tag.tone),
  }))
  const categoryItems: PublicArticleMetaItem[] = article.category
    ? [{ label: article.category, kind: 'meta', className: '' }]
    : []
  const originalSourceItems: PublicArticleMetaItem[] = article.originalSource && article.originalSource !== article.source.name
    ? [{ label: `原始：${article.originalSource}`, kind: 'meta', className: '' }]
    : []
  const sourceItems: PublicArticleMetaItem[] = [{ label: article.source.name, kind: 'meta', className: '' }]
  const metaGroups = [brandItems, tagItems, categoryItems, originalSourceItems, sourceItems].filter((group) => group.length > 0)

  return (
    <li
      className="public-article-item public-article-motion"
      style={{ '--public-reveal-delay': `${Math.min(revealIndex, 7) * 35}ms` } as CSSProperties}
    >
      <Link href={`/news/${article.id}`} className="public-article-link group/article grid grid-cols-[4rem_minmax(0,1fr)] gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)] sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-5">
        <time dateTime={effectiveDate} className="pt-5 text-right font-mono text-xs tabular-nums text-[var(--public-muted)]">
          {formatPublicTime(effectiveDate)}
        </time>

        <div className="relative border-l border-[var(--public-hairline)] pb-4 pl-4 pt-1 sm:pl-6 sm:pb-5">
          <span aria-hidden="true" className="public-timeline-marker absolute left-[-5px] top-5 h-2.5 w-2.5 rounded-full border-2 border-[var(--public-canvas)] bg-[var(--public-primary)] shadow-[0_0_0_1px_var(--public-hairline)]" />
          <div className="public-article-surface rounded-none bg-transparent px-4 py-4 sm:px-5 sm:py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-y-1 text-xs text-[var(--public-muted)]">
                {metaGroups.map((group, groupIndex) => (
                  <span key={`meta-group-${groupIndex}`} className="inline-flex items-center gap-1">
                    {groupIndex > 0 && <span aria-hidden="true" className="mx-1 inline-flex h-5 items-center text-[var(--public-hairline-strong)]">|</span>}
                    {group.map((item, itemIndex) => (
                      <span key={`${item.label}-${itemIndex}`} className={item.kind === 'brand' ? 'inline-flex items-center rounded-none bg-[var(--public-ink)] px-1.5 py-0.5 font-medium text-white' : `${item.className} inline-flex items-center`}>
                        {item.label}
                      </span>
                    ))}
                  </span>
                ))}
              </div>

              <h2 className="public-article-title public-display mt-2 text-xl leading-snug text-[var(--public-ink)] sm:text-2xl">
                {article.title}
              </h2>
              <p className="mt-2 line-clamp-2 text-pretty text-sm leading-7 text-[var(--public-body)]">
                {article.excerpt || '暂无摘要'}
              </p>

            </div>

            <span aria-label={`评分 ${article.score} 分`} className="flex shrink-0 items-center text-xs text-[var(--public-muted)]">
              <ScoreBadge score={article.score} variant="compact-square" />
            </span>
          </div>
          </div>
        </div>
      </Link>
    </li>
  )
}
