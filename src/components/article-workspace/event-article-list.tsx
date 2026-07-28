"use client";

import { type ReactNode, type RefObject } from "react";

const EVENT_TABLE_CLASS = "w-max min-w-[1120px] table-auto border-separate border-spacing-0 text-xs";
const EVENT_SOURCE_HEADER_CLASS = "md:sticky md:left-[52px] z-[3] w-[1%] max-w-[88px] border-b border-r bg-muted px-2 py-1 text-left font-medium";
const EVENT_TITLE_HEADER_CLASS = "md:sticky z-[3] min-w-[150px] max-w-[240px] border-b border-r bg-muted px-2 py-1 text-left font-medium";
const EVENT_SOURCE_CELL_CLASS = "md:sticky md:left-[52px] z-[2] w-[1%] max-w-[88px] border-r px-2 py-1.5 align-middle";
const EVENT_TITLE_CELL_CLASS = "md:sticky z-[2] min-w-[150px] border-r px-2 py-1.5 align-middle";

export type EventArticleRowTone = "member" | "recommended" | "brand";
export type EventArticleRowHighlight = "current" | "selected" | "representative";

/**
 * Event 成员/候选的唯一展示模型。
 *
 * 业务组件只负责把 DTO 映射到这里；桌面表格和移动卡片不再分别解释
 * 来源、代表关系、状态和操作，避免同一次需求只改到一个断点。
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
  eventKey: string;
  sourceStatus: string;
  publicStatus: string;
  pushStatus: string;
  selection?: ReactNode;
  actions?: ReactNode;
  tone: EventArticleRowTone;
  highlight?: EventArticleRowHighlight;
  onTitleClick?: () => void;
}

interface EventArticleListProps {
  rows: EventArticleRowModel[];
  sourceHeaderRef?: RefObject<HTMLTableCellElement | null>;
  sourceWidth: number;
}

export function EventArticleList({ rows, sourceHeaderRef, sourceWidth }: EventArticleListProps) {
  return (
    <>
      <div className="space-y-1.5 md:hidden">
        {rows.map((row) => <EventArticleCard key={row.id} row={row} />)}
      </div>
      <div className="hidden max-w-full overflow-x-auto md:block">
        <table className={EVENT_TABLE_CLASS}>
          <EventComparisonTableHeader sourceHeaderRef={sourceHeaderRef} sourceWidth={sourceWidth} />
          <tbody>
            {rows.map((row) => <EventArticleTableRow key={row.id} row={row} sourceWidth={sourceWidth} />)}
          </tbody>
        </table>
      </div>
    </>
  );
}

function EventArticleCard({ row }: { row: EventArticleRowModel }) {
  return (
    <article className={`min-w-0 border p-2 text-xs ${cardToneClass(row.tone, row.highlight)}`}>
      <div className="flex min-w-0 items-center justify-between gap-2 text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5">
          {row.selection}
          <span className="shrink-0 tabular-nums">#{row.index}</span>
          <span className="min-w-0 truncate font-mono tabular-nums">{row.time}</span>
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
      <div className="mt-1.5 grid min-w-0 grid-cols-2 gap-x-3 gap-y-1 border-t border-current/10 pt-1.5 text-[11px] leading-4 md:grid-cols-4">
        <MobileEventMeta label="来源" value={row.source} />
        <MobileEventMeta label="代表关系" value={row.representative} />
        <MobileEventMeta label="品牌" value={row.brand} />
        <MobileEventMeta label="事件键" value={row.eventKey} mono />
        <MobileEventMeta label="状态" value={row.sourceStatus} />
        <MobileEventMeta label="公开" value={row.publicStatus} />
        <MobileEventMeta label="推送" value={row.pushStatus} />
      </div>
      {row.actions && <div className="mt-1.5 flex min-w-0 flex-wrap gap-1 border-t border-current/10 pt-1.5">{row.actions}</div>}
    </article>
  );
}

function MobileEventMeta({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <span className="mr-1 text-muted-foreground">{label}</span>
      <span className={`break-words ${mono ? "font-mono break-all" : ""}`}>{value}</span>
    </div>
  );
}

function EventComparisonTableHeader({ sourceHeaderRef, sourceWidth }: { sourceHeaderRef?: RefObject<HTMLTableCellElement | null>; sourceWidth: number }) {
  return (
    <thead className="sticky top-0 z-[1] bg-muted/60 text-muted-foreground">
      <tr>
        <th className="md:sticky md:left-0 z-[3] w-[52px] border-b border-r bg-muted px-1 py-1 text-center font-medium">序号</th>
        <th className="w-[1%] whitespace-nowrap border-b border-r bg-muted px-2 py-1 text-left font-medium">发布时间</th>
        <th className="border-b border-r px-1 py-1 text-center font-medium">总分</th>
        <th ref={sourceHeaderRef} className={EVENT_SOURCE_HEADER_CLASS}><div className="max-w-[72px] truncate">来源</div></th>
        <th style={{ left: 52 + sourceWidth }} className={EVENT_TITLE_HEADER_CLASS}>标题</th>
        <th className="border-b border-r px-1 py-1 text-center font-medium">代表关系</th>
        <th className="border-b border-r px-2 py-1 text-left font-medium">品牌</th>
        <th className="border-b border-r px-2 py-1 text-left font-medium">事件键</th>
        <th className="border-b border-r px-2 py-1 text-left font-medium">状态</th>
        <th className="border-b border-r px-2 py-1 text-left font-medium">公开</th>
        <th className="border-b border-r px-2 py-1 text-left font-medium">推送</th>
        <th className="md:sticky md:right-0 z-[3] border-b bg-muted px-2 py-1 text-left font-medium">操作</th>
      </tr>
    </thead>
  );
}

function EventArticleTableRow({ row, sourceWidth }: { row: EventArticleRowModel; sourceWidth: number }) {
  const rowBackground = tableToneClass(row.tone, row.highlight);
  return (
    <tr className={`group whitespace-nowrap border-b last:border-b-0 ${rowBackground}`}>
      <td className={`md:sticky md:left-0 z-[2] border-r px-1 py-1.5 align-middle ${rowBackground}`}>
        <div className="flex items-center justify-center gap-1">{row.selection}<span className="tabular-nums text-muted-foreground">{row.index}</span></div>
      </td>
      <td className="w-[1%] whitespace-nowrap border-r px-2 py-1.5 font-mono tabular-nums align-middle text-muted-foreground">{row.time}</td>
      <td className="border-r px-1 py-1.5 text-center font-semibold tabular-nums align-middle">{row.score}</td>
      <td className={`${EVENT_SOURCE_CELL_CLASS} ${rowBackground}`} title={row.source}><div className="max-w-[72px] truncate text-muted-foreground">{row.source}</div></td>
      <td style={{ left: 52 + sourceWidth }} className={`${EVENT_TITLE_CELL_CLASS} ${rowBackground}`}>
        {row.onTitleClick ? (
          <button type="button" onClick={row.onTitleClick} className={`block max-w-[240px] truncate text-left font-medium hover:underline ${row.titleClassName ?? ""}`} title={row.title}>{row.title}</button>
        ) : <div className={`block max-w-[240px] truncate text-left font-medium ${row.titleClassName ?? ""}`} title={row.title}>{row.title}</div>}
      </td>
      <td className="border-r px-1 py-1.5 text-center align-middle">{row.representative}</td>
      <td className="border-r px-2 py-1.5 align-middle text-muted-foreground" title={row.brand}><div className="max-w-[160px] truncate">{row.brand}</div></td>
      <td className="border-r px-2 py-1.5 font-mono align-middle text-muted-foreground" title={row.eventKey}><div className="max-w-[260px] truncate">{row.eventKey}</div></td>
      <td className="border-r px-2 py-1.5 align-middle text-muted-foreground">{row.sourceStatus}</td>
      <td className="border-r px-2 py-1.5 align-middle text-muted-foreground">{row.publicStatus}</td>
      <td className="border-r px-2 py-1.5 align-middle text-muted-foreground">{row.pushStatus}</td>
      <td className={`md:sticky md:right-0 z-[2] px-1 py-1 align-middle ${rowBackground}`}><div className="flex items-center gap-1 whitespace-nowrap">{row.actions}</div></td>
    </tr>
  );
}

function cardToneClass(tone: EventArticleRowTone, highlight?: EventArticleRowHighlight): string {
  if (highlight === "current") return "border-sky-200 bg-sky-50";
  if (highlight === "selected") return "border-amber-200 bg-amber-50";
  if (highlight === "representative") return "border-emerald-200 bg-emerald-50/60";
  if (tone === "recommended") return "border-sky-200 bg-sky-50";
  if (tone === "brand") return "border-amber-200 bg-amber-50/60";
  return "bg-background";
}

function tableToneClass(tone: EventArticleRowTone, highlight?: EventArticleRowHighlight): string {
  if (highlight === "current") return "bg-sky-50";
  if (highlight === "selected") return "bg-amber-50";
  if (highlight === "representative") return "bg-emerald-50";
  if (tone === "recommended") return "bg-sky-50";
  if (tone === "brand") return "bg-amber-50/60";
  return "bg-background group-hover:bg-muted/20";
}
