import type { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ArticleDetailDto } from '@/contracts/articles';
import { parseEventSubjects } from '@/contracts/event-identity';
import { splitBrands } from '@/lib/shared/article-codecs';
import type { ComparisonTarget, WorkspaceStatusTone } from './types';
import {
  eventKeyRelationLabel,
  fullTimeLabel,
  parseEventKeyParts,
  timeDistanceLabel,
  workspaceStatusClass,
} from './utils';
import { WORKSPACE_SECTION_CLASS } from './styles';

export function eventStatusLabel(status: string): string {
  return ({ active: '活跃', merged: '已并入其他事件' } as Record<string, string>)[status]
    ?? (status || '未知');
}

export function eventReviewStatusLabel(status: string): string {
  return ({ confirmed: '聚类已确认', pending: '待人工复核' } as Record<string, string>)[status]
    ?? (status || '待确认');
}

export function ArticleComparisonDialog({
  detail,
  target,
  onOpenChange,
  onMoveCurrent,
  onMergeCandidate,
}: {
  detail: ArticleDetailDto | null;
  target: ComparisonTarget | null;
  onOpenChange: (open: boolean) => void;
  onMoveCurrent: () => void;
  onMergeCandidate: () => void;
}) {
  const currentParts = parseEventKeyParts(detail?.eventKey || '');
  const targetParts = parseEventKeyParts(target?.eventKey || '');

  if (!detail || !target) {
    return <Dialog open={false} onOpenChange={onOpenChange} />;
  }

  const sharedBrandLabel = target.matchedBrands.join('、') || '无明确品牌交集';
  const comparisonSummary = [
    {
      title: '相同点',
      body: `品牌交集：${sharedBrandLabel}`,
    },
    {
      title: '关键差异',
      body: `${eventKeyRelationLabel(detail.eventKey, target.eventKey)} · 时间间隔 ${timeDistanceLabel(detail.publishedAt ?? detail.createdAt, target.publishedAt ?? target.createdAt)}`,
    },
    {
      title: '系统依据',
      body: `${target.reason}${target.confidence == null ? '' : `（AI 归类判断置信度 ${target.confidence}%）`}`,
    },
  ];

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88dvh] max-w-[calc(100%-1rem)] gap-0 overflow-y-auto overflow-x-hidden rounded-none p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-4 py-3 pr-12">
          <DialogTitle className="text-base">文章事件对比</DialogTitle>
          <DialogDescription>对照事件身份、品牌和时间差异后，再决定文章归属。</DialogDescription>
        </DialogHeader>

        <div className="grid min-w-0 divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <ComparisonColumn
            eyebrow="当前文章"
            title={detail.title}
            source={detail.source.name}
            time={fullTimeLabel(detail.publishedAt ?? detail.createdAt)}
            score={detail.score}
            brand={splitBrands(detail.brand).join('、') || '—'}
            subjects={parseEventSubjects(detail.eventSubjects).join('、') || currentParts.subjects}
            action={detail.eventAction || currentParts.action}
            object={detail.eventObject || currentParts.object}
            eventKey={detail.eventKey || '—'}
          />
          <ComparisonColumn
            eyebrow={target.kind === 'recommended' ? '系统关联候选' : '同品牌候选'}
            title={target.title}
            source={target.source}
            time={fullTimeLabel(target.publishedAt ?? target.createdAt)}
            score={target.score}
            brand={splitBrands(target.brand).join('、') || '—'}
            subjects={targetParts.subjects}
            action={targetParts.action}
            object={targetParts.object}
            eventKey={target.eventKey || '—'}
          />
        </div>

        <div className="grid gap-2 border-t bg-muted/15 p-3 text-xs sm:grid-cols-3">
          {comparisonSummary.map((item) => (
            <div key={item.title} className="bg-background p-2">
              <p className="font-semibold">{item.title}</p>
              <p className="mt-1 leading-5 text-muted-foreground">{item.body}</p>
            </div>
          ))}
        </div>

        <DialogFooter className="border-t px-4 py-3">
          <Button size="sm" variant="outline" className="h-8 rounded-none" onClick={() => onOpenChange(false)}>
            保持现状
          </Button>
          {target.kind === 'brand' && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-none border-amber-300 text-amber-800 hover:bg-amber-50"
              onClick={onMergeCandidate}
            >
              并入当前事件
            </Button>
          )}
          <Button size="sm" className="h-8 rounded-none" onClick={onMoveCurrent}>
            {target.kind === 'recommended' ? '将当前文章移至推荐事件' : '将当前文章移至该事件'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ComparisonColumn({
  eyebrow,
  title,
  source,
  time,
  score,
  brand,
  subjects,
  action,
  object,
  eventKey,
}: {
  eyebrow: string;
  title: string;
  source: string;
  time: string;
  score: number | null;
  brand: string;
  subjects: string;
  action: string;
  object: string;
  eventKey: string;
}) {
  const fields = [
    { label: '事件主体', value: subjects },
    { label: '事件行为', value: action },
    { label: '具体事项', value: object },
    { label: '品牌', value: brand },
    { label: '事件键', value: eventKey, mono: true },
  ];

  return (
    <section className="min-w-0 p-3 sm:p-4">
      <p className="text-xs font-semibold text-muted-foreground">{eyebrow}</p>
      <h3 className="mt-1 break-words text-sm font-semibold leading-5">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{source} · {time} · 综合分 {score ?? '—'}</p>
      <div className="mt-3 grid gap-1.5 text-xs">
        {fields.map((field) => (
          <ComparisonField key={field.label} {...field} />
        ))}
      </div>
    </section>
  );
}

export function ComparisonField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] gap-2 border-t pt-1.5 first:border-t-0 first:pt-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={`min-w-0 break-words ${mono ? 'break-all font-mono' : ''}`}>
        {value || '—'}
      </span>
    </div>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: WorkspaceStatusTone;
  children: ReactNode;
}) {
  return (
    <span className={`inline-flex min-h-5 items-center px-1.5 py-0.5 text-[11px] font-medium leading-4 ${workspaceStatusClass(tone)}`}>
      {children}
    </span>
  );
}

export function InlineMetric({
  label,
  value,
  suffix = '',
  danger = false,
}: {
  label: string;
  value: number | string | null;
  suffix?: string;
  danger?: boolean;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-muted-foreground">{label}</span>
      <strong className={`font-mono text-[13px] tabular-nums ${danger ? 'text-red-700' : 'text-foreground'}`}>
        {value ?? '—'}{value == null ? '' : suffix}
      </strong>
    </span>
  );
}

export function EmptyEventTab({ children }: { children: ReactNode }) {
  return <div className="bg-muted/20 px-3 py-2 text-xs text-muted-foreground">{children}</div>;
}

export function EventCalibrationGroup({
  title,
  count,
  context,
  children,
}: {
  title: string;
  count: number;
  context?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={WORKSPACE_SECTION_CLASS}>
      <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold">{title}</h3>
        <span className="bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{count}</span>
        {context && <div className="min-w-0 flex-1 basis-auto">{context}</div>}
      </div>
      <div className="min-w-0 bg-muted/10">{children}</div>
    </section>
  );
}

export function SectionHeader({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
      <h2 className="min-w-0 truncate text-xs font-semibold">{title}</h2>
      {meta && <span className="ml-auto max-w-[52%] truncate text-right text-xs text-muted-foreground">{meta}</span>}
    </div>
  );
}

export function MetaRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  const title = typeof value === 'string' ? value : undefined;
  return (
    <div className="grid min-w-0 grid-cols-[74px_minmax(0,1fr)] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={`min-w-0 truncate ${mono ? 'font-mono text-xs tabular-nums' : ''}`} title={title}>
        {value}
      </span>
    </div>
  );
}
