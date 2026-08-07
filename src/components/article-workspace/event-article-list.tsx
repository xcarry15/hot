'use client';

import { memo, type ReactNode } from 'react';
import { ScoreBadge } from '@/components/ui/score-badge';

export type EventArticleRowTone = 'member' | 'recommended' | 'brand';
export type EventArticleRowHighlight = 'current' | 'selected' | 'representative';

/**
 * Event 成员与候选文章共用的紧凑卡片模型。
 *
 * 抽屉宽度有限，卡片只保留决策所需信息，避免宽表横向滚动。
 */
export interface EventArticleRowModel {
  id: string;
  time: string;
  score: number;
  source: string;
  title: string;
  titleClassName?: string;
  representative: ReactNode;
  brand: string;
  eventKey: string;
  brandDisplay?: ReactNode;
  eventKeyDisplay?: ReactNode;
  recommendationInterval?: string;
  publicStatus: string;
  pushStatus: string;
  selection?: ReactNode;
  actions?: ReactNode;
  tone: EventArticleRowTone;
  highlight?: EventArticleRowHighlight;
  onTitleClick?: () => void;
}

const CARD_CLASS = 'min-w-0 px-2 py-1.5 text-xs';
const META_ROW_CLASS = 'mt-0.5 grid min-w-0 gap-y-0.5 text-[11px] leading-4 text-muted-foreground sm:flex sm:flex-wrap sm:items-center sm:gap-x-2';
const ACTIONS_CLASS = 'flex min-w-0 flex-wrap items-center gap-0.5 [&>*]:flex-none';

export const EventArticleList = memo(function EventArticleList({ rows }: { rows: EventArticleRowModel[] }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      {rows.map((row) => <EventArticleCard key={row.id} row={row} />)}
    </div>
  );
});

function EventArticleCard({ row }: { row: EventArticleRowModel }) {
  const titleSizeClass = row.tone === 'member' ? 'text-[13px]' : 'text-sm';
  const titleClassName = row.titleClassName ?? (row.tone === 'member' ? '' : 'text-foreground');
  const titleLayoutClass = `truncate ${titleSizeClass} font-medium leading-5 sm:overflow-visible sm:whitespace-normal sm:text-clip sm:break-words ${titleClassName}`;

  return (
    <article className={`${CARD_CLASS} ${cardToneClass(row.tone, row.highlight)}`}>
      <div className="flex min-w-0 items-start gap-2">
        {row.selection && <div className="mt-0.5 shrink-0">{row.selection}</div>}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-4 text-muted-foreground sm:gap-x-2">
            <span className="font-mono tabular-nums">{row.time}</span>
            <span className="min-w-0 max-w-[42%] truncate sm:max-w-none">{row.source}</span>
            <StatusText value={row.publicStatus} />
            <StatusText value={row.pushStatus} />
            {row.recommendationInterval && <span className="whitespace-nowrap">间隔 {row.recommendationInterval}</span>}
            <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-1 gap-y-0.5 sm:ml-auto sm:basis-auto sm:justify-end">
              <span className="shrink-0">{row.representative}</span>
              {row.actions && <div className={ACTIONS_CLASS}>{row.actions}</div>}
            </div>
          </div>

          <div className="mt-0.5 flex min-w-0 items-start gap-1">
            <ScoreBadge score={row.score} variant="compact-square" />
            {row.onTitleClick ? (
              <button
                type="button"
                onClick={row.onTitleClick}
                className={`min-w-0 flex-1 text-left hover:underline ${titleLayoutClass}`}
                title={row.title}
              >
                {row.title}
              </button>
            ) : (
              <p className={`min-w-0 flex-1 ${titleLayoutClass}`} title={row.title}>{row.title}</p>
            )}
          </div>

          <div className={META_ROW_CLASS}>
            <div className="min-w-0 sm:contents">
              <ComparisonText label="品牌" value={row.brand} displayValue={row.brandDisplay} />
            </div>
            <div className="min-w-0 sm:contents">
              <ComparisonText label="事件键" value={row.eventKey} displayValue={row.eventKeyDisplay} mono />
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function ComparisonText({
  label,
  value,
  displayValue,
  mono = false,
}: {
  label: string;
  value: string;
  displayValue?: ReactNode;
  mono?: boolean;
}) {
  return (
    <span className={mono ? 'block min-w-0 truncate font-mono' : 'block min-w-0 truncate'} title={value}>
      {label}：{displayValue ?? value}
    </span>
  );
}

function StatusText({ value }: { value: string }) {
  const className = value.includes('失败')
      ? 'bg-red-50 px-1.5 py-0.5 text-red-700'
      : value.includes('部分')
      ? 'bg-amber-50 px-1.5 py-0.5 text-amber-800'
      : value.includes('已公开') || value.includes('已推送')
        ? 'bg-emerald-50 px-1.5 py-0.5 text-emerald-700'
        : value.includes('未公开') || value.includes('未推送')
          ? 'bg-red-50 px-1.5 py-0.5 text-red-700'
          : 'text-muted-foreground';

  return <span className={`inline-flex items-center ${className}`}>{value}</span>;
}

function cardToneClass(tone: EventArticleRowTone, highlight?: EventArticleRowHighlight): string {
  if (highlight === 'current') return 'border-l-2 border-l-sky-400 bg-sky-50/70';
  if (highlight === 'selected') return 'border-l-2 border-l-amber-400 bg-amber-50/70';
  if (highlight === 'representative') return 'border-l-2 border-l-violet-300 bg-violet-50/50';
  if (tone === 'recommended') return 'border-l-2 border-l-sky-300 bg-sky-50/40';
  if (tone === 'brand') return 'border-l-2 border-l-amber-300 bg-amber-50/30';
  return 'bg-background';
}
