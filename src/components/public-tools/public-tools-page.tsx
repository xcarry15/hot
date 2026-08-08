import PublicFooter from '@/components/public-footer';
import PublicHeader from '@/components/public-header';
import { PUBLIC_TOOL_CATEGORIES } from './tool-catalog';
import PublicToolSection from './tool-section';

const toolCount = PUBLIC_TOOL_CATEGORIES.reduce((total, category) => total + category.tools.length, 0);

export default function PublicToolsPage() {
  return (
    <div className="public-site flex min-h-[100dvh] flex-col bg-background text-foreground">
      <PublicHeader active="tools" />

      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-10 sm:px-6 sm:py-14">
        <header className="public-section-enter border-b border-[var(--public-hairline)] pb-7 sm:pb-9">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-[var(--public-primary)]">工具入口</p>
              <h1 className="public-display mt-2 text-3xl leading-tight text-[var(--public-ink)] sm:text-4xl">工具中心</h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--public-body)] sm:text-base">选址、地理位置、数据分析与文件工具入口。工具在新标签页打开，具体功能由各工具站点提供。</p>
            </div>
            <span className="inline-flex shrink-0 items-center border border-[var(--public-hairline-strong)] bg-[var(--public-surface)] px-2.5 py-1 text-xs tabular-nums text-[var(--public-muted)]">{toolCount} 个工具</span>
          </div>
        </header>

        <div className="mt-8 space-y-10 sm:mt-10 sm:space-y-12">
          {PUBLIC_TOOL_CATEGORIES.map((category, index) => (
            <PublicToolSection key={category.id} category={category} sectionIndex={index} />
          ))}
        </div>
      </main>

      <PublicFooter />
    </div>
  );
}
