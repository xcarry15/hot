import { Check } from 'lucide-react';
import { TOOL_DIRECTORY_TAG_DEFINITIONS } from '@/contracts/tool-directory';
import type { PublicToolStatus, PublicToolTag } from './types';

export const STATUS_BADGE_META: Record<PublicToolStatus, { label: string; className: string }> = {
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

export const TAG_BADGE_CLASSES: Record<PublicToolTag, string> = {
  free: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  paid: 'border-amber-200 bg-amber-50 text-amber-800',
  popular: 'border-rose-200 bg-rose-50 text-rose-800',
  updated: 'border-blue-200 bg-blue-50 text-blue-800',
  latest: 'border-violet-200 bg-violet-50 text-violet-800',
};

export function ToolMetaLabel({
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

export function StatusBadge({ status }: { status: PublicToolStatus }) {
  const meta = STATUS_BADGE_META[status];
  if (!meta.label) return null;
  return <ToolMetaLabel label={meta.label} className={meta.className} />;
}

export function TagBadges({ tags }: { tags: readonly PublicToolTag[] }) {
  const visibleTags = tags.slice(0, 2);
  const hiddenCount = Math.max(tags.length - visibleTags.length, 0);
  if (visibleTags.length === 0 && hiddenCount === 0) return null;
  return (
    <>
      {visibleTags.map((tag) => (
        <ToolMetaLabel key={tag} label={TAG_LABELS[tag]} className={TAG_BADGE_CLASSES[tag]} />
      ))}
      {hiddenCount > 0 && (
        <span className="inline-flex h-6 items-center border border-[var(--public-hairline)] px-2 text-xs font-semibold leading-none text-[var(--public-muted)]">+{hiddenCount}</span>
      )}
    </>
  );
}

export function ToolBadgeToggle({
  label,
  className,
  selected,
  onClick,
  title,
}: {
  label: string;
  className: string;
  selected: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={selected}
      onClick={onClick}
      className={`inline-flex h-6 items-center gap-1 whitespace-nowrap border px-2 text-xs font-semibold leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${className}`}
    >
      {selected && <Check className="size-3 shrink-0" aria-hidden="true" />}
      {label}
    </button>
  );
}
