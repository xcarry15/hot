"use client"

import type { Dispatch, SetStateAction } from "react"
import { Button } from "@/components/ui/button"
import { EMPTY_FILTER_STATE, isFilterStateActive, type FilterState, type StepFilterKey } from "./types"
import { PRIMARY_FILTER_CHIPS, type FilterChipKey } from "./constants"

type FilterChip = (typeof PRIMARY_FILTER_CHIPS)[number]

interface CrawlLogFiltersProps {
  filterState: FilterState
  setFilterState: Dispatch<SetStateAction<FilterState>>
  activePrimaryFilter: FilterChipKey
  secondaryFilterChips: readonly FilterChip[]
  filterCounts: Partial<Record<FilterChipKey, number>>
}

export function CrawlLogFilters({ filterState, setFilterState, activePrimaryFilter, secondaryFilterChips, filterCounts }: CrawlLogFiltersProps) {
  return (
          <div className="flex min-w-0 w-full flex-col gap-1">
            <div
              className="flex min-w-0 items-center gap-1 overflow-x-auto pb-0.5 overscroll-contain"
              role="radiogroup"
              aria-label="任务状态分类"
            >
              {PRIMARY_FILTER_CHIPS.map(chip => {
                const isAllChip = chip.key === 'all'
                const statusKey = chip.key as StepFilterKey
                const active = activePrimaryFilter === chip.key
                const n = filterCounts[chip.key] ?? 0
                return (
                  <button
                    key={chip.key}
                    onClick={() => {
                      if (isAllChip) {
                        setFilterState(prev => ({ ...prev, chips: new Set() }))
                        return
                      }
                      setFilterState(prev => ({ ...prev, chips: new Set([statusKey]) }))
                    }}
                    role="radio"
                    aria-checked={active}
                    title={chip.description}
                    className={`flex h-7 shrink-0 items-center gap-1.5 border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      active
                        ? 'border-foreground bg-foreground font-medium text-background'
                        : 'border-border bg-background text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <span>{chip.label}</span>
                    <span className={`text-[11px] tabular-nums ${active ? 'opacity-80' : 'text-muted-foreground/70'}`}>
                      ({n})
                    </span>
                  </button>
                )
              })}
              {isFilterStateActive(filterState) && (
                <Button size="sm" variant="ghost" onClick={() => setFilterState(EMPTY_FILTER_STATE)} className="h-7 px-2 text-xs text-muted-foreground" title="清除所有筛选">清除</Button>
              )}
            </div>

            {secondaryFilterChips.length > 0 && (
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-l-2 border-muted-foreground/30 pl-2 pb-0.5 overscroll-contain" role="radiogroup" aria-label="具体任务状态">
                {secondaryFilterChips.map(chip => {
                  const statusKey = chip.key as StepFilterKey
                  const active = filterState.chips.has(statusKey)
                  return (
                    <button
                      key={chip.key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      title={chip.description}
                      onClick={() => setFilterState(prev => ({ ...prev, chips: new Set([statusKey]) }))}
                      className={`h-6 shrink-0 border px-2 text-[11px] transition-colors ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-muted-foreground hover:text-foreground'}`}
                    >
                      {chip.label} <span className="tabular-nums opacity-75">({filterCounts[chip.key] ?? 0})</span>
                    </button>
                  )
                })}
              </div>
            )}

          </div>
  )
}
