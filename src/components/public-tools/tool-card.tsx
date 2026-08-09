import type { CSSProperties } from 'react';
import { TOOL_DIRECTORY_TAG_DEFINITIONS, isToolDirectoryLinkableStatus } from '@/contracts/tool-directory';
import PublicToolIcon from './tool-icons';
import type { PublicTool, PublicToolStatus, PublicToolTag } from './types';

const STATUS_META: Record<PublicToolStatus, { label: string; className: string }> = {
  active: {
    label: '',
    className: '',
  },
  maintenance: {
    label: '维护中',
    className: 'border-orange-200 bg-orange-50 text-orange-800',
  },
  coming_soon: {
    label: '即将上线',
    className: 'border-sky-200 bg-sky-50 text-sky-800',
  },
  disabled: {
    label: '停用',
    className: 'border-stone-200 bg-stone-100 text-stone-500',
  },
};

const TAG_LABELS = Object.fromEntries(
  TOOL_DIRECTORY_TAG_DEFINITIONS.map(({ id, label }) => [id, label]),
) as Record<(typeof TOOL_DIRECTORY_TAG_DEFINITIONS)[number]['id'], string>;

const TAG_CLASS_NAMES: Record<PublicToolTag, string> = {
  free: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  paid: 'border-amber-200 bg-amber-50 text-amber-800',
  popular: 'border-rose-200 bg-rose-50 text-rose-800',
  updated: 'border-blue-200 bg-blue-50 text-blue-800',
  latest: 'border-violet-200 bg-violet-50 text-violet-800',
};

function StatusBadge({ status }: { status: PublicToolStatus }) {
  const meta = STATUS_META[status];
  if (!meta.label) return null;
  return <ToolMetaLabel label={meta.label} className={meta.className} />;
}

function ToolMetaLabel({
  label,
  className,
}: {
  label: string;
  className: string;
}) {
  return (
    <span className={`inline-flex h-6 items-center whitespace-nowrap border px-2 text-xs font-semibold leading-none ${className}`}>{label}</span>
  );
}

function TagBadges({ tags }: { tags: readonly (keyof typeof TAG_LABELS)[] }) {
  const visibleTags = tags.slice(0, 2);
  const hiddenCount = Math.max(tags.length - visibleTags.length, 0);
  if (visibleTags.length === 0 && hiddenCount === 0) return null;
  return (
    <>
      {visibleTags.map((tag) => (
        <ToolMetaLabel key={tag} label={TAG_LABELS[tag]} className={TAG_CLASS_NAMES[tag]} />
      ))}
      {hiddenCount > 0 && (
        <span className="inline-flex h-6 items-center border border-[var(--public-hairline)] px-2 text-xs font-semibold leading-none text-[var(--public-muted)]">+{hiddenCount}</span>
      )}
    </>
  );
}

function ToolCardBody({ tool, disabled }: { tool: PublicTool; disabled: boolean }) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className={`mt-0.5 shrink-0 ${disabled ? 'text-[var(--public-muted)]' : 'text-[var(--public-primary)]'}`}>
          <PublicToolIcon name={tool.icon} />
        </span>
        <h3 className="min-w-0 flex-1 line-clamp-1 text-base font-semibold leading-6 text-[var(--public-ink)] sm:line-clamp-2">{tool.name}</h3>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <StatusBadge status={tool.status} />
          <TagBadges tags={tool.tags} />
        </div>
      </div>
      <p className="mt-1.5 min-w-0 line-clamp-2 text-[12px] leading-5 text-[var(--public-body)] sm:text-[13px]">{tool.description}</p>
    </div>
  );
}

export default function PublicToolCard({
  tool,
  revealIndex = 0,
}: {
  tool: PublicTool;
  revealIndex?: number;
}) {
  const disabled = !isToolDirectoryLinkableStatus(tool.status) || !tool.href;
  const cardSurfaceClassName = disabled
    ? 'cursor-not-allowed border-[var(--public-hairline)] bg-[var(--public-surface-soft)] opacity-80 shadow-[0_2px_8px_rgb(20_20_19_/_0.04)]'
    : 'public-pressable border-[var(--public-hairline-soft)] bg-[var(--public-surface)] shadow-[0_4px_12px_rgb(20_20_19_/_0.07)] transition-[transform,box-shadow,background-color,border-color] duration-200 hover:-translate-y-0.5 hover:border-[color:rgb(204_120_92_/_0.34)] hover:bg-[var(--public-surface)] hover:shadow-[0_12px_24px_rgb(20_20_19_/_0.12)]';
  const cardClassName = `group relative flex min-h-[96px] min-w-0 flex-col overflow-hidden rounded-[3px] border px-3 py-3 sm:min-h-[116px] sm:px-3.5 ${cardSurfaceClassName} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)]`;
  const style = { '--public-reveal-delay': `${Math.min(revealIndex, 7) * 35}ms` } as CSSProperties;

  return (
    <li className="h-full min-w-0 public-article-motion" style={style}>
      {disabled ? (
        <div className={cardClassName} aria-disabled="true">
          <ToolCardBody tool={tool} disabled={disabled} />
        </div>
      ) : (
        <a
          href={tool.href ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          className={cardClassName}
          aria-label={`打开${tool.name}（外部工具）`}
        >
          <ToolCardBody tool={tool} disabled={disabled} />
          <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[var(--public-primary)] opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
        </a>
      )}
    </li>
  );
}
