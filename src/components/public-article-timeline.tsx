'use client'

import { useEffect, useRef, useState } from 'react'
import type { PublicArticleDateGroupDto } from '@/contracts/public-articles'
import { getPublicDateLabel, getPublicDayLabel, getPublicMonthLabel } from '@/lib/shared/public-date'
import PublicArticleCard from '@/components/public-article-card'

interface Props {
  groups: PublicArticleDateGroupDto[]
}

interface PublicArticleMonthGroup {
  key: string
  label: string
  count: number
  groups: PublicArticleDateGroupDto[]
}

function groupByMonth(groups: PublicArticleDateGroupDto[]): PublicArticleMonthGroup[] {
  const monthGroups = new Map<string, PublicArticleMonthGroup>()
  for (const group of groups) {
    const key = group.date.slice(0, 7)
    const monthGroup = monthGroups.get(key) ?? {
      key,
      label: getPublicMonthLabel(group.date),
      count: 0,
      groups: [],
    }
    monthGroup.count += group.count
    monthGroup.groups.push(group)
    monthGroups.set(key, monthGroup)
  }
  return [...monthGroups.values()]
}

export default function PublicArticleTimeline({ groups }: Props) {
  const [firstGroup, ...restGroups] = groups
  const latestMonthKey = firstGroup?.date.slice(0, 7)
  const [openDates, setOpenDates] = useState(() => new Set(firstGroup ? [firstGroup.date] : []))
  const [openMonth, setOpenMonth] = useState<string | null>(latestMonthKey ?? null)
  const previousLatestDate = useRef(firstGroup?.date)
  const previousLatestMonth = useRef(latestMonthKey)

  useEffect(() => {
    if (!firstGroup || previousLatestDate.current === firstGroup.date) return
    previousLatestDate.current = firstGroup.date
    setOpenDates((current) => new Set(current).add(firstGroup.date))
    const nextMonthKey = firstGroup.date.slice(0, 7)
    if (previousLatestMonth.current !== nextMonthKey) {
      previousLatestMonth.current = nextMonthKey
      setOpenMonth(nextMonthKey)
    }
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
  const monthGroups = groupByMonth(orderedGroups)

  function toggleMonth(monthKey: string) {
    if (openMonth === monthKey) {
      setOpenMonth(null)
      return
    }

    setOpenMonth(monthKey)
    const targetMonth = monthGroups.find((monthGroup) => monthGroup.key === monthKey)
    if (!targetMonth) return
    setOpenDates((current) => {
      const next = new Set(current)
      for (const group of targetMonth.groups) next.add(group.date)
      return next
    })
  }

  return (
    <div className="space-y-4">
      {monthGroups.map((monthGroup, monthIndex) => {
        const isMonthOpen = openMonth === monthGroup.key
        const monthContentId = `public-month-content-${monthGroup.key}`

        return (
          <section key={monthGroup.key} aria-labelledby={`public-month-group-${monthGroup.key}`}>
            <button
              type="button"
              aria-controls={monthContentId}
              aria-expanded={isMonthOpen}
              className={`group/month flex w-full items-center justify-between gap-4 border-t px-1 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)] ${isMonthOpen ? 'border-[var(--public-hairline-strong)]' : 'border-[var(--public-hairline)] hover:border-[var(--public-primary)]'}`}
              onClick={() => toggleMonth(monthGroup.key)}
            >
              <span className="flex min-w-0 items-baseline gap-3">
                <span id={`public-month-group-${monthGroup.key}`} className={`public-display truncate text-xl sm:text-2xl ${isMonthOpen ? 'text-[var(--public-primary)]' : 'text-[var(--public-ink)]'}`}>
                  {monthGroup.label}
                </span>
                <span className="shrink-0 text-xs text-[var(--public-muted)]">{monthGroup.count} 篇</span>
              </span>
              <span
                aria-hidden="true"
                className={`mr-1 block h-2.5 w-2.5 shrink-0 border-b border-r border-[var(--public-muted-soft)] transition-transform duration-300 motion-reduce:transition-none ${isMonthOpen ? 'rotate-[225deg]' : 'rotate-45'}`}
              />
            </button>

            <div
              id={monthContentId}
              aria-hidden={!isMonthOpen}
              inert={!isMonthOpen}
              className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none ${isMonthOpen ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0'}`}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="ml-2 pl-4 pt-4 sm:ml-4 sm:pl-5">
                  <div className="space-y-7">
                    {monthGroup.groups.map((group, dateIndex) => {
                      const isOpen = openDates.has(group.date)
                      const contentId = `public-date-group-${group.date}`
                      const isLatestGroup = monthIndex === 0 && dateIndex === 0

                      return (
                        <section key={group.date} aria-labelledby={`${contentId}-label`}>
                          <button
                            type="button"
                            aria-controls={contentId}
                            aria-expanded={isOpen}
                            className="group/date flex w-full items-center justify-between gap-4 pb-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)]"
                            onClick={() => toggleDate(group.date)}
                          >
                            <span className="flex min-w-0 items-baseline gap-2 sm:gap-3">
                              <span id={`${contentId}-label`} className={`public-display truncate text-lg sm:text-xl ${isLatestGroup ? 'text-[var(--public-primary)]' : 'text-[var(--public-ink)]'}`}>
                                {getPublicDayLabel(group.date)}
                              </span>
                              <span className="shrink-0 text-xs text-[var(--public-muted)]">{group.count} 篇</span>
                            </span>
                            <span
                              aria-hidden="true"
                              className={`mr-1 block h-2.5 w-2.5 shrink-0 border-b border-r border-[var(--public-muted-soft)] transition-transform duration-300 motion-reduce:transition-none ${isOpen ? 'rotate-[225deg]' : 'rotate-45'}`}
                            />
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
                </div>
              </div>
            </div>
          </section>
        )
      })}
    </div>
  )
}
