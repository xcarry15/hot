"use client";

import { type ReactNode } from "react";

import { ScoreBadge } from "@/components/ui/score-badge";

export type EventArticleRowTone = "member" | "recommended" | "brand";
export type EventArticleRowHighlight = "current" | "selected" | "representative";

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
  sourceStatus: string;
  publicStatus: string;
  pushStatus: string;
  selection?: ReactNode;
  actions?: ReactNode;
  tone: EventArticleRowTone;
  highlight?: EventArticleRowHighlight;
  onTitleClick?: () => void;
}

export function EventArticleList({ rows }: { rows: EventArticleRowModel[] }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      {rows.map((row) => <EventArticleCard key={row.id} row={row} />)}
    </div>
  );
}

function EventArticleCard({ row }: { row: EventArticleRowModel }) {
  if (row.tone === "member") {
    return <EventMemberCard row={row} />;
  }
  return (
    <article className={`min-w-0 border-b border-border/60 px-2 py-1.5 text-xs last:border-b-0 ${cardToneClass(row.tone, row.highlight)}`}>
      <div className="flex min-w-0 items-start gap-2">
        {row.selection && <div className="mt-0.5 shrink-0">{row.selection}</div>}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-4 text-muted-foreground sm:gap-x-2">
            <span className="font-mono tabular-nums">{row.time}</span>
            <span className="min-w-0 max-w-[42%] truncate sm:max-w-none">{row.source}</span>
            <span className="inline-flex items-center gap-1">总分 <ScoreBadge score={row.score} variant="compact-square" /></span>
            {row.recommendationInterval && <span className="whitespace-nowrap">间隔 {row.recommendationInterval}</span>}
            <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-1 gap-y-0.5 sm:ml-auto sm:basis-auto sm:justify-end">
              <span className="shrink-0">{row.representative}</span>
              {row.actions && <div className="flex min-w-0 flex-wrap items-center gap-0.5 [&>*]:flex-none">{row.actions}</div>}
            </div>
          </div>
          {row.onTitleClick ? (
            <button
              type="button"
              onClick={row.onTitleClick}
              className={`mt-0.5 block w-full break-words text-left text-sm font-medium leading-5 hover:underline ${row.titleClassName ?? "text-foreground"}`}
              title={row.title}
            >
              {row.title}
            </button>
          ) : (
            <p className={`mt-0.5 break-words text-sm font-medium leading-5 ${row.titleClassName ?? "text-foreground"}`} title={row.title}>{row.title}</p>
          )}
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4 text-muted-foreground">
            <ComparisonText label="品牌" value={row.brand} displayValue={row.brandDisplay} />
            <ComparisonText label="事件键" value={row.eventKey} displayValue={row.eventKeyDisplay} mono />
            <span>{row.sourceStatus}</span>
            <StatusText value={row.publicStatus} />
            <StatusText value={row.pushStatus} />
          </div>
        </div>
      </div>

    </article>
  );
}

function EventMemberCard({ row }: { row: EventArticleRowModel }) {
  return (
    <article className={`min-w-0 border-b border-border/60 px-2 py-1.5 text-xs last:border-b-0 ${cardToneClass(row.tone, row.highlight)}`}>
      <div className="flex min-w-0 items-start gap-2">
        {row.selection && <div className="mt-0.5 shrink-0">{row.selection}</div>}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-4 text-muted-foreground sm:gap-x-2">
            <span className="font-mono tabular-nums">{row.time}</span>
            <span className="min-w-0 max-w-[42%] truncate sm:max-w-none">{row.source}</span>
            <span className="inline-flex items-center gap-1">总分 <ScoreBadge score={row.score} variant="compact-square" /></span>
            <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-1 gap-y-0.5 sm:ml-auto sm:basis-auto sm:justify-end">
              <span className="shrink-0">{row.representative}</span>
              {row.actions && <div className="flex min-w-0 flex-wrap items-center gap-0.5 [&>*]:flex-none">{row.actions}</div>}
            </div>
          </div>
          {row.onTitleClick ? (
            <button type="button" onClick={row.onTitleClick} className="mt-0.5 block w-full break-words text-left text-[13px] font-medium leading-5 hover:underline" title={row.title}>{row.title}</button>
          ) : <p className="mt-0.5 break-words text-[13px] font-medium leading-5">{row.title}</p>}
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4 text-muted-foreground">
            <ComparisonText label="品牌" value={row.brand} displayValue={row.brandDisplay} />
            <ComparisonText label="事件键" value={row.eventKey} displayValue={row.eventKeyDisplay} mono />
            <span>{row.sourceStatus}</span>
            <StatusText value={row.publicStatus} />
            <StatusText value={row.pushStatus} />
          </div>
        </div>
      </div>
    </article>
  );
}

function ComparisonText({ label, value, displayValue, mono = false }: { label: string; value: string; displayValue?: ReactNode; mono?: boolean }) {
  return (
    <span className={`${mono ? "min-w-0 break-all font-mono" : "min-w-0 break-words"}`}>
      {label}：{displayValue ?? value}
    </span>
  );
}

function StatusText({ value }: { value: string }) {
  const className = value.includes("失败")
    ? "bg-red-50 px-1.5 py-0.5 text-red-700"
    : value.includes("部分")
      ? "bg-amber-50 px-1.5 py-0.5 text-amber-800"
      : value.includes("已公开") || value.includes("已推送")
        ? "bg-emerald-50 px-1.5 py-0.5 text-emerald-700"
        : value.includes("未公开") || value.includes("未推送")
          ? "bg-red-50 px-1.5 py-0.5 text-red-700"
          : "text-muted-foreground";
  return <span className={`inline-flex items-center ${className}`}>{value}</span>;
}

function cardToneClass(tone: EventArticleRowTone, highlight?: EventArticleRowHighlight): string {
  if (highlight === "current") return "border-l-2 border-l-sky-400 bg-sky-50/70";
  if (highlight === "selected") return "border-l-2 border-l-amber-400 bg-amber-50/70";
  if (highlight === "representative") return "border-l-2 border-l-violet-300 bg-violet-50/50";
  if (tone === "recommended") return "border-l-2 border-l-sky-300 bg-sky-50/40";
  if (tone === "brand") return "border-l-2 border-l-amber-300 bg-amber-50/30";
  return "bg-background";
}
