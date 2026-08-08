import type { CSSProperties } from 'react';
import { TOOL_DIRECTORY_TAG_DEFINITIONS } from '@/contracts/tool-directory';
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
  disabled: {
    label: '暂不可用',
    className: 'text-[var(--public-muted)]',
  },
};

const TAG_LABELS = Object.fromEntries(
  TOOL_DIRECTORY_TAG_DEFINITIONS.map(({ id, label }) => [id, label]),
) as Record<(typeof TOOL_DIRECTORY_TAG_DEFINITIONS)[number]['id'], string>;

function StatusBadge({ status }: { status: PublicToolStatus }) {
  const meta = STATUS_META[status];
  if (!meta.label) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 px-0.5 text-[10px] font-semibold tracking-[0.04em] ${meta.className}`}>
      <span aria-hidden="true" className="h-1 w-1 shrink-0 bg-current opacity-60" />
      {meta.label}
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
        <span key={tag} className="inline-flex items-center gap-1.5 px-0.5 text-[10px] font-medium tracking-[0.04em] text-[var(--public-muted)]">
          <span aria-hidden="true" className="h-1 w-1 shrink-0 bg-current opacity-45" />
          {TAG_LABELS[tag]}
        </span>
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
      <div className="flex items-start gap-2.5">
        <span className={`mt-0.5 shrink-0 ${disabled ? 'text-[var(--public-muted)]' : 'text-[var(--public-primary)]'}`}>
          <PublicToolIcon name={tool.icon} />
        </span>
        <div className="flex min-w-0 flex-1 items-start gap-1.5">
          <h3 className="min-w-0 flex-1 line-clamp-2 text-sm font-semibold leading-5 text-[var(--public-ink)] sm:text-base sm:leading-6">{tool.name}</h3>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            <StatusBadge status={tool.status} />
            <TagBadges tags={tool.tags} />
            {!disabled && tool.kind === 'download' && !tool.tags.includes('download') && (
              <span className="inline-flex items-center gap-1.5 px-0.5 text-[10px] font-medium tracking-[0.04em] text-[var(--public-muted)]">
                <span aria-hidden="true" className="h-1 w-1 shrink-0 bg-current opacity-45" />
                下载
              </span>
            )}
          </div>
        </div>
      </div>

      <p className="mt-2.5 min-w-0 line-clamp-2 text-[12px] leading-5 text-[var(--public-body)] sm:text-[13px]">{tool.description}</p>
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
  const disabled = tool.status === 'disabled' || !tool.href;
  const cardClassName = `group relative flex min-w-0 h-[132px] flex-col overflow-hidden border px-3 py-3.5 sm:h-[140px] sm:px-4 ${disabled ? 'cursor-not-allowed border-[var(--public-hairline)] bg-[var(--public-surface-soft)] opacity-80' : 'public-pressable border-[var(--public-hairline-soft)] bg-[var(--public-surface)] shadow-[0_1px_0_rgb(20_20_19_/_0.03)] transition-[background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-[color:rgb(204_120_92_/_0.34)] hover:bg-[var(--public-surface)] hover:shadow-[0_8px_22px_rgb(20_20_19_/_0.06)]'} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)]`;
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
          aria-label={`${tool.kind === 'download' ? '下载' : '打开'}${tool.name}（外部工具）`}
        >
          <ToolCardBody tool={tool} disabled={disabled} />
          <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[var(--public-primary)] opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
        </a>
      )}
    </li>
  );
}
