import PublicPageShell from '@/components/public-page-shell';
import PublicToolSection from './tool-section';
import type { PublicToolCategory } from './types';

export default function PublicToolsPage({
  categories,
  error = false,
}: {
  categories: readonly PublicToolCategory[];
  error?: boolean;
}) {
  const toolCount = categories.reduce((total, category) => total + category.tools.length, 0);
  return (
    <PublicPageShell active="tools" mainClassName="px-4 py-6 sm:px-6 sm:py-8">
      <header className="public-section-enter flex flex-wrap items-center justify-between gap-2">
        <h1 className="sr-only">工具中心</h1>
        <p className="min-w-0 max-w-3xl text-sm leading-6 text-[var(--public-body)] sm:text-base">面向选址人士的免费实用工具，帮你快速找到好位置、看懂数据，做出更稳的拓店决策。</p>
        <span className="shrink-0 text-xs tabular-nums text-[var(--public-muted)]">{toolCount} 个工具</span>
      </header>

      {error ? (
        <div className="mt-6 border border-[var(--public-hairline)] bg-[var(--public-surface-soft)] px-5 py-10 text-center">
          <p className="text-sm font-medium text-[var(--public-ink)]">工具目录暂时无法加载</p>
          <p className="mt-2 text-xs leading-6 text-[var(--public-muted)]">请稍后刷新页面重试。</p>
        </div>
      ) : (
        <div className="mt-6 space-y-8 sm:mt-7 sm:space-y-9">
          {categories.map((category, index) => (
            <PublicToolSection key={category.id} category={category} sectionIndex={index} />
          ))}
        </div>
      )}
    </PublicPageShell>
  );
}
