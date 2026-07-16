'use client'

import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PublicArticleDateGroupDto } from '@/contracts/public-articles'
import { getPublicDateLabel } from '@/lib/shared/public-date'
import PublicArticleCard from '@/components/public-article-card'

interface Props {
  groups: PublicArticleDateGroupDto[]
}

export default function PublicArticleTimeline({ groups }: Props) {
  const [firstGroup, ...restGroups] = groups
  const [openDates, setOpenDates] = useState(() => new Set(firstGroup ? [firstGroup.date] : []))
  const previousLatestDate = useRef(firstGroup?.date)

  useEffect(() => {
    if (!firstGroup || previousLatestDate.current === firstGroup.date) return
    previousLatestDate.current = firstGroup.date
    setOpenDates((current) => new Set(current).add(firstGroup.date))
  }, [firstGroup])

  function toggleDate(date: string) {
    setOpenDates((current) => {
      const next = new Set(current)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }

  const orderedGroups = firstGroup ? [firstGroup, ...restGroups] : []

  return (
    <div className="space-y-8">
      {orderedGroups.map((group, groupIndex) => {
        const isOpen = openDates.has(group.date)
        const contentId = `public-date-group-${group.date}`

        return (
          <section key={group.date} aria-labelledby={`${contentId}-label`}>
            <button
              type="button"
              aria-controls={contentId}
              aria-expanded={isOpen}
              className="group/date flex w-full items-center justify-between gap-4 border-b border-[var(--public-hairline)] pb-3 text-left outline-none transition-colors hover:border-[var(--public-primary)] focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)]"
              onClick={() => toggleDate(group.date)}
            >
              <span className="flex min-w-0 items-baseline gap-2 sm:gap-3">
                <span id={`${contentId}-label`} className={`public-display truncate text-xl sm:text-2xl ${groupIndex === 0 ? 'text-[var(--public-primary)]' : 'text-[var(--public-ink)]'}`}>
                  {getPublicDateLabel(group.date)}
                </span>
                <span className="shrink-0 text-xs text-[var(--public-muted)]">{group.count} 篇</span>
              </span>
              <ChevronDown aria-hidden="true" className={`h-5 w-5 shrink-0 text-[var(--public-muted)] transition-transform duration-300 motion-reduce:transition-none ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            <div
              id={contentId}
              aria-hidden={!isOpen}
              inert={!isOpen}
              className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none ${isOpen ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0'}`}
            >
              <div className="min-h-0 overflow-hidden">
                <ol className="pt-2" aria-label={`${getPublicDateLabel(group.date)}文章`}>
                  {group.items.map((article) => <PublicArticleCard key={article.id} article={article} />)}
                </ol>
              </div>
            </div>
          </section>
        )
      })}
    </div>
  )
}
