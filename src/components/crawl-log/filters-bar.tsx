'use client'

import type { Dispatch, SetStateAction } from 'react'
import type { FilterState, StepFilterKey } from './types'
import { PRIMARY_FILTER_CHIPS, type FilterChipKey } from './constants'

type FilterChip = (typeof PRIMARY_FILTER_CHIPS)[number]

const PRIMARY_FILTER_CLASS = 'flex h-6 w-full items-center justify-center gap-0.5 border px-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-7 sm:w-auto sm:justify-start sm:gap-1.5 sm:px-2.5 sm:text-xs'
const SECONDARY_FILTER_CLASS = 'h-6 shrink-0 border px-2 text-[11px] transition-colors'

interface CrawlLogFiltersProps {
  filterState: FilterState
  setFilterState: Dispatch<SetStateAction<FilterState>>
  activePrimaryFilter: FilterChipKey
  secondaryFilterChips: readonly FilterChip[]
  filterCounts: Partial<Record<FilterChipKey, number>>
}

export function CrawlLogFilters({
  filterState,
  setFilterState,
  activePrimaryFilter,
  secondaryFilterChips,
  filterCounts,
}: CrawlLogFiltersProps) {
  return (
    <div className="flex min-w-0 w-full flex-col gap-1">
      <div
        className="grid min-w-0 grid-cols-4 gap-1 pb-0.5 overscroll-contain sm:flex sm:items-center sm:overflow-x-auto"
        role="radiogroup"
        aria-label="任务状态分类"
      >
        {PRIMARY_FILTER_CHIPS.map(chip => {
          const isAllChip = chip.key === 'all'
          const statusKey = chip.key as StepFilterKey
          const active = activePrimaryFilter === chip.key
          const count = filterCounts[chip.key] ?? 0

          return (
            <button
              key={chip.key}
              type="button"
              onClick={() => setFilterState(prev => ({
                ...prev,
                chips: isAllChip ? new Set() : new Set([statusKey]),
              }))}
              role="radio"
              aria-checked={active}
              title={chip.description}
              className={`${PRIMARY_FILTER_CLASS} ${active
                ? 'border-foreground bg-foreground font-medium text-background'
                : 'border-border bg-background text-muted-foreground hover:text-foreground'}`}
            >
              <span>{chip.label}</span>
              <span className={`text-[11px] tabular-nums ${active ? 'opacity-80' : 'text-muted-foreground/70'}`}>
                ({count})
              </span>
            </button>
          )
        })}
      </div>

      {secondaryFilterChips.length > 0 && (
        <div
          className="flex min-w-0 items-center gap-1 overflow-x-auto border-l-2 border-muted-foreground/30 pl-2 pb-0.5 overscroll-contain"
          role="radiogroup"
          aria-label="具体任务状态"
        >
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
                className={`${SECONDARY_FILTER_CLASS} ${active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'}`}
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
