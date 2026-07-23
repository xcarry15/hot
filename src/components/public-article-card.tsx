import Link from 'next/link'
import { splitBrands } from '@/lib/shared/article-codecs'
import { ScoreBadge } from '@/components/ui/score-badge'
import type { PublicArticleListItemDto } from '@/contracts/public-articles'
import { formatPublicTime } from '@/lib/shared/public-date'
import type { CSSProperties } from 'react'

type PublicArticleMetaItem = {
  label: string
  kind: 'brand' | 'meta'
  className: string
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
    .map((brand) => ({ label: brand.trim(), kind: 'brand' as const, className: '' }))
    .filter((item) => item.label)
  const categoryItems: PublicArticleMetaItem[] = article.category
    ? [{ label: article.category, kind: 'meta', className: '' }]
    : []
  const originalSourceItems: PublicArticleMetaItem[] = article.originalSource && article.originalSource !== article.source.name
    ? [{ label: `原始：${article.originalSource}`, kind: 'meta', className: '' }]
    : []
  const sourceItems: PublicArticleMetaItem[] = [{ label: article.source.name, kind: 'meta', className: '' }]
  const metaGroups = [brandItems, categoryItems, originalSourceItems, sourceItems].filter((group) => group.length > 0)

  return (
    <li
      className="public-article-item public-article-motion"
      style={{ '--public-reveal-delay': `${Math.min(revealIndex, 7) * 35}ms` } as CSSProperties}
    >
      <Link href={`/news/${article.id}`} className="public-article-link group/article grid grid-cols-[3.25rem_minmax(0,1fr)] gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)] sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-5">
        <time dateTime={effectiveDate} className="pt-3 text-right font-mono text-[11px] tabular-nums text-[var(--public-muted)] sm:pt-5 sm:text-xs">
          {formatPublicTime(effectiveDate)}
        </time>

        <div className="relative border-l border-[var(--public-hairline)] pb-3 pl-3 pt-0.5 sm:pl-6 sm:pb-5 sm:pt-1">
          <span aria-hidden="true" className="public-timeline-marker absolute left-[-4px] top-4 h-2.5 w-2.5 rounded-full border-2 border-[var(--public-canvas)] bg-[var(--public-primary)] shadow-[0_0_0_1px_var(--public-hairline)] sm:left-[-5px] sm:top-5" />
          <div className="public-article-surface rounded-none bg-transparent px-2.5 py-3 sm:px-5 sm:py-5">
            <div className="flex min-w-0 items-start gap-2 sm:gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-start gap-2">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-y-1 text-xs text-[var(--public-muted)]">
                    {metaGroups.map((group, groupIndex) => (
                      <span key={`meta-group-${groupIndex}`} className="inline-flex items-center gap-1">
                        {groupIndex > 0 && <span aria-hidden="true" className="mx-0.5 inline-flex h-5 items-center text-[var(--public-hairline-strong)] sm:mx-1">|</span>}
                        {group.map((item, itemIndex) => (
                          <span key={`${item.label}-${itemIndex}`} className={item.kind === 'brand' ? 'inline-flex items-center rounded-none bg-[var(--public-ink)] px-1 py-0.5 font-medium text-white sm:px-1.5' : `${item.className} inline-flex items-center`}>
                            {item.label}
                          </span>
                        ))}
                      </span>
                    ))}
                  </div>
                  <span aria-label={`评分 ${article.score} 分`} className="flex shrink-0 items-center sm:hidden">
                    <ScoreBadge score={article.score} variant="compact-square" />
                  </span>
                </div>

                <h2 className="public-article-title public-display mt-1.5 line-clamp-2 text-lg leading-7 text-[var(--public-ink)] sm:mt-2 sm:line-clamp-none sm:text-2xl sm:leading-snug">
                  {article.title}
                </h2>
                <p className="mt-1.5 line-clamp-2 text-[13px] leading-6 text-[var(--public-body)] sm:mt-2 sm:text-sm sm:leading-7">
                  {article.excerpt || '暂无摘要'}
                </p>

              </div>

              <span aria-label={`评分 ${article.score} 分`} className="hidden shrink-0 items-center text-xs text-[var(--public-muted)] sm:flex">
                <ScoreBadge score={article.score} variant="compact-square" />
              </span>
            </div>
          </div>
        </div>
      </Link>
    </li>
  )
}
