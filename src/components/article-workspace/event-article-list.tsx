"use client";

import { type ReactNode } from "react";

export type EventArticleRowTone = "member" | "recommended" | "brand";
export type EventArticleRowHighlight = "current" | "selected" | "representative";

/**
 * Event 成员/候选的统一展示模型。
 *
 * 详情抽屉统一使用文章卡片，避免关键操作依赖宽表格的横向滚动；
 * 同一模型同时承载成员、系统推荐和同品牌候选，减少文案与状态分叉。
 */
export interface EventArticleRowModel {
  id: string;
  index: ReactNode;
  time: string;
  score: ReactNode;
  source: string;
  title: string;
  titleClassName?: string;
  representative: ReactNode;
  brand: string;
  reason?: string;
  selection?: ReactNode;
  actions?: ReactNode;
  tone: EventArticleRowTone;
  highlight?: EventArticleRowHighlight;
  onTitleClick?: () => void;
}

interface EventArticleListProps {
  rows: EventArticleRowModel[];
}

export function EventArticleList({ rows }: EventArticleListProps) {
  if (rows.length === 0) {
    return <p className="border border-dashed px-2.5 py-3 text-xs text-muted-foreground">暂无文章</p>;
  }
  return (
    <div className="divide-y border-y">
      {rows.map((row) => <EventArticleCard key={row.id} row={row} />)}
    </div>
  );
}

function EventArticleCard({ row }: { row: EventArticleRowModel }) {
  return (
    <article className={`min-w-0 px-2.5 py-2 text-xs ${cardToneClass(row.tone, row.highlight)}`}>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {row.selection}
          <span className="shrink-0 tabular-nums">{row.index === "推荐" ? "推荐" : `#${row.index}`}</span>
          <span className="shrink-0 font-mono tabular-nums">{row.time}</span>
          <span className="min-w-0 truncate">· {row.source}</span>
        </div>
        <span className="shrink-0 font-semibold tabular-nums text-foreground">总分 {row.score}</span>
      </div>
      {row.onTitleClick ? (
        <button type="button" onClick={row.onTitleClick} className={`mt-1 block w-full break-words text-left text-sm font-medium leading-5 hover:underline ${row.titleClassName ?? "text-sky-950"}`} title={row.title}>
          {row.title}
        </button>
      ) : (
        <p className={`mt-1 break-words text-sm font-medium leading-5 ${row.titleClassName ?? "text-sky-950"}`} title={row.title}>{row.title}</p>
      )}
      <div className="mt-1.5 grid min-w-0 grid-cols-2 gap-x-3 gap-y-1 border-t border-current/10 pt-1.5 text-[11px] leading-4">
        <MobileEventMeta label="事件角色" value={row.representative} />
        <MobileEventMeta label="品牌" value={row.brand} />
      </div>
      {row.reason && <p className="mt-1.5 break-words border-t border-current/10 pt-1.5 text-[11px] leading-4 text-muted-foreground"><span className="font-medium text-foreground">推荐原因：</span>{row.reason}</p>}
      {row.actions && <div className="mt-1.5 flex min-w-0 flex-wrap gap-1 border-t border-current/10 pt-1.5">{row.actions}</div>}
    </article>
  );
}

function MobileEventMeta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="mr-1 text-muted-foreground">{label}</span>
      <span className="break-words">{value}</span>
    </div>
  );
}

function cardToneClass(tone: EventArticleRowTone, highlight?: EventArticleRowHighlight): string {
  if (highlight === "current") return "bg-sky-50";
  if (highlight === "selected") return "bg-amber-50";
  if (highlight === "representative") return "bg-emerald-50/60";
  if (tone === "recommended") return "bg-sky-50";
  if (tone === "brand") return "bg-amber-50/60";
  return "bg-background";
}
