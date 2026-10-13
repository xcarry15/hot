'use client'

import { useCallback, useState } from 'react'
import type { PublicArticleDateGroupDto } from '@/contracts/public-articles'
import { getPublicDateLabel, getPublicDayLabel, getPublicMonthLabel } from '@/lib/shared/public-date'
import PublicArticleCard from '@/components/public-article-card'
import type { CSSProperties } from 'react'

interface Props {
  groups: PublicArticleDateGroupDto[]
}

export default function PublicArticleTimeline({ groups }: Props) {
  const [collapsedDates, setCollapsedDates] = useState<Set<string>>(new Set())

  const toggleGroup = useCallback((date: string) => {
    setCollapsedDates((prev) => {
      const next = new Set(prev)
      if (next.has(date)) {
        next.delete(date)
      } else {
        next.add(date)
      }
      return next
    })
  }, [])

  return (
    <div>
      {groups.map((group, groupIndex) => {
        const isCollapsed = collapsedDates.has(group.date)
        const isNewMonth = groupIndex === 0 || group.date.slice(0, 7) !== groups[groupIndex - 1].date.slice(0, 7)
        return (
          <div key={group.date}>
            {isNewMonth && (
              <p className={`${groupIndex === 0 ? 'mb-2' : 'mb-2 mt-7'} px-0 text-xs font-medium tabular-nums tracking-[0.08em] text-[var(--public-muted)] sm:px-1`}>
                {getPublicMonthLabel(group.date)}
              </p>
            )}
            <section aria-labelledby={`public-date-group-${group.date}`}>
              <button
                type="button"
                onClick={() => toggleGroup(group.date)}
                aria-expanded={!isCollapsed}
                aria-controls={`public-date-items-${group.date}`}
                id={`public-date-group-${group.date}`}
                className={`public-date-heading public-display flex w-full items-center gap-2 px-0 text-left text-lg sm:px-1 sm:text-2xl ${groupIndex === 0 ? 'text-[var(--public-primary)]' : 'text-[var(--public-ink)]'}`}
                style={{ '--public-reveal-delay': `${Math.min(groupIndex, 3) * 30}ms` } as CSSProperties}
              >
                <span className="shrink-0 transition-transform duration-150" style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }} aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </span>
                <span>{getPublicDayLabel(group.date)}</span>
              </button>
              <div className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out sm:mt-1 ${isCollapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}>
                <ol
                  id={`public-date-items-${group.date}`}
                  className="min-h-0 overflow-hidden"
                  aria-hidden={isCollapsed}
                  aria-label={`${getPublicDateLabel(group.date)}文章`}
                >
                  {group.items.map((article, articleIndex) => (
                    <PublicArticleCard
                      key={article.id}
                      article={article}
                      revealIndex={groupIndex * 2 + articleIndex}
                    />
                  ))}
                </ol>
              </div>
            </section>
          </div>
        )
      })}
    </div>
  )
}
