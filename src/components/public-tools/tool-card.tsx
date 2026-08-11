import type { CSSProperties } from 'react';
import { isToolDirectoryLinkableStatus } from '@/contracts/tool-directory';
import PublicToolIcon from './tool-icons';
import { StatusBadge, TagBadges } from './tool-badges';
import type { PublicTool } from './types';

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
    ? 'cursor-not-allowed border-[var(--public-hairline)] bg-[var(--public-surface-soft)] opacity-60 shadow-[0_1px_2px_rgb(20_20_19_/_0.05)] grayscale-[0.7]'
    : 'public-pressable border-[var(--public-hairline-soft)] bg-gradient-to-br from-[var(--public-surface-soft)] via-[var(--public-surface-strong)] to-[color:rgb(20_20_19_/_0.04)] shadow-[0_1px_2px_rgb(20_20_19_/_0.08),0_2px_4px_rgb(20_20_19_/_0.06)] transition-[transform,box-shadow,border-color] duration-300 ease-out hover:-translate-y-0.5 hover:border-[color:rgb(204_120_92_/_0.3)] hover:shadow-[0_4px_8px_rgb(20_20_19_/_0.1),0_8px_16px_rgb(20_20_19_/_0.08)]';
  const cardClassName = `group relative flex min-h-[88px] min-w-0 flex-col overflow-hidden border px-3.5 py-3 sm:min-h-[100px] sm:px-4 sm:py-3.5 ${cardSurfaceClassName} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)]`;
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
        </a>
      )}
    </li>
  );
}
