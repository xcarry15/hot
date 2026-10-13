import Link from 'next/link'
import { splitBrands } from '@/lib/shared/article-codecs'
import { ScoreBadge } from '@/components/ui/score-badge'
import type { PublicArticleListItemDto } from '@/contracts/public-articles'
import { formatPublicTime } from '@/lib/shared/public-date'
import type { CSSProperties } from 'react'

type PublicArticleMetaItem = {
  label: string
  kind: 'brand' | 'meta'
}

export default function PublicArticleCard({
  article,
  revealIndex = 0,
}: {
  article: PublicArticleListItemDto
  revealIndex?: number
}) {
  const brands = splitBrands(article.brand)
  const effectiveDate = article.publishedAt || article.createdAt
  const brandItems: PublicArticleMetaItem[] = brands
    .map((brand) => ({ label: brand.trim(), kind: 'brand' as const }))
    .filter((item) => item.label)
  const categoryItems: PublicArticleMetaItem[] = article.category
    ? [{ label: article.category, kind: 'meta' }]
    : []
  const sourceItems: PublicArticleMetaItem[] = article.originalSource?.trim()
    ? [{ label: article.originalSource, kind: 'meta' }]
    : [{ label: article.source.name, kind: 'meta' }]
  const metaGroups = [brandItems, categoryItems, sourceItems].filter((group) => group.length > 0)

  return (
    <li
      className="public-article-item public-article-motion"
      style={{ '--public-reveal-delay': `${Math.min(revealIndex, 7) * 35}ms` } as CSSProperties}
    >
      <Link href={`/news/${article.id}`} className="public-article-link group/article grid grid-cols-[2rem_minmax(0,1fr)] gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)] sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-5">
        <time dateTime={effectiveDate} className="pt-3.5 pr-2 text-right font-mono text-[10px] tabular-nums text-[var(--public-muted)] sm:pt-6 sm:pr-2 sm:text-xs">
          {formatPublicTime(effectiveDate)}
        </time>

        <div className="relative border-l border-[var(--public-hairline)] pb-3 pl-2 pt-0.5 sm:pl-6 sm:pb-5 sm:pt-1">
          <span aria-hidden="true" className="public-timeline-marker absolute left-[-5px] top-4 h-2.5 w-2.5 rounded-full border-2 border-[var(--public-canvas)] bg-[var(--public-primary)] shadow-[0_0_0_1px_var(--public-hairline)] sm:top-[1.6875rem]" />
          <div className="public-article-surface min-w-0 bg-transparent px-2 pb-2.5 pt-1 sm:px-5 sm:py-3">
            <h2 className="public-article-title public-display line-clamp-2 text-lg leading-7 text-[var(--public-ink)] sm:line-clamp-none sm:text-2xl sm:leading-snug">
              {article.title}
            </h2>

            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-xs text-[var(--public-muted)] sm:mt-2 sm:gap-x-1.5">
              <span aria-label={`评分 ${article.score} 分`} className="mr-1 flex shrink-0 items-center sm:mr-1.5">
                <ScoreBadge score={article.score} variant="meta" />
              </span>
              {metaGroups.map((group, groupIndex) => (
                <span key={`meta-group-${groupIndex}`} className="inline-flex items-center gap-1">
                  {group.map((item, itemIndex) => (
                    <span key={`${item.label}-${itemIndex}`} className={item.kind === 'brand' ? 'inline-flex items-center bg-[var(--public-ink)] px-1 py-0.5 font-medium text-white sm:px-1.5' : 'inline-flex items-center'}>
                      {item.label}
                    </span>
                  ))}
                </span>
              ))}
            </div>
            <p className="mt-1.5 line-clamp-2 text-[13px] leading-6 text-[var(--public-body)] sm:mt-2 sm:text-sm sm:leading-7">
              {article.excerpt || '暂无摘要'}
            </p>
          </div>
        </div>
      </Link>
    </li>
  )
}
