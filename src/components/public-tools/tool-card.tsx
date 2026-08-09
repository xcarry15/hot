import type { CSSProperties } from 'react';
import { TOOL_DIRECTORY_TAG_DEFINITIONS, isToolDirectoryLinkableStatus } from '@/contracts/tool-directory';
import PublicToolIcon from './tool-icons';
import type { PublicTool, PublicToolStatus } from './types';

const STATUS_META: Record<PublicToolStatus, { label: string; className: string }> = {
  active: {
    label: '',
    className: '',
  },
  beta: {
    label: '内测中',
    className: 'text-amber-800',
  },
  maintenance: {
    label: '维护中',
    className: 'text-orange-800',
  },
  coming_soon: {
    label: '即将上线',
    className: 'text-sky-800',
  },
  disabled: {
    label: '停用',
    className: 'text-[var(--public-muted)]',
  },
};

const TAG_LABELS = Object.fromEntries(
  TOOL_DIRECTORY_TAG_DEFINITIONS.map(({ id, label }) => [id, label]),
) as Record<(typeof TOOL_DIRECTORY_TAG_DEFINITIONS)[number]['id'], string>;

function StatusBadge({ status }: { status: PublicToolStatus }) {
  const meta = STATUS_META[status];
  if (!meta.label) return null;
  return <ToolMetaLabel label={meta.label} className={`font-semibold ${meta.className}`} />;
}

function ToolMetaLabel({
  label,
  className,
  dotClassName = 'opacity-60',
}: {
  label: string;
  className: string;
  dotClassName?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-0.5 text-[10px] tracking-[0.04em] ${className}`}>
      <span aria-hidden="true" className={`h-1 w-1 shrink-0 bg-current ${dotClassName}`} />
      {label}
    </span>
  );
}

function TagBadges({ tags }: { tags: readonly (keyof typeof TAG_LABELS)[] }) {
  const visibleTags = tags.slice(0, 2);
  const hiddenCount = Math.max(tags.length - visibleTags.length, 0);
  if (visibleTags.length === 0 && hiddenCount === 0) return null;
  return (
    <>
      {visibleTags.map((tag) => (
        <ToolMetaLabel key={tag} label={TAG_LABELS[tag]} className="font-medium text-[var(--public-muted)]" dotClassName="opacity-45" />
      ))}
      {hiddenCount > 0 && (
        <span className="inline-flex items-center px-0.5 text-[10px] font-medium text-[var(--public-muted)]">+{hiddenCount}</span>
      )}
    </>
  );
}

function ToolCardBody({ tool, disabled }: { tool: PublicTool; disabled: boolean }) {
  return (
    <>
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 shrink-0 ${disabled ? 'text-[var(--public-muted)]' : 'text-[var(--public-primary)]'}`}>
          <PublicToolIcon name={tool.icon} />
        </span>
        <div className="flex min-w-0 flex-1 items-start gap-1.5">
          <h3 className="min-w-0 flex-1 line-clamp-2 text-sm font-semibold leading-5 text-[var(--public-ink)] sm:text-[15px]">{tool.name}</h3>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            <StatusBadge status={tool.status} />
            <TagBadges tags={tool.tags} />
          </div>
        </div>
      </div>

      <p className="mt-1.5 min-w-0 line-clamp-2 text-[12px] leading-5 text-[var(--public-body)] sm:text-[13px]">{tool.description}</p>
    </>
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
  const cardClassName = `group relative flex min-h-[112px] min-w-0 flex-col overflow-hidden border px-3 py-3 sm:min-h-[116px] sm:px-3.5 ${disabled ? 'cursor-not-allowed border-[var(--public-hairline)] bg-[var(--public-surface-soft)] opacity-80' : 'public-pressable border-[var(--public-hairline-soft)] bg-[var(--public-surface)] transition-[background-color,border-color] duration-200 hover:border-[color:rgb(204_120_92_/_0.34)] hover:bg-[var(--public-surface)]'} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)]`;
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
