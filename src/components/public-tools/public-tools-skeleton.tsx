import PublicPageShell from '@/components/public-page-shell'

export default function PublicToolsSkeleton() {
  return (
    <PublicPageShell active="tools" mainClassName="px-4 py-6 sm:px-6 sm:py-8">
      <div aria-busy="true" aria-label="工具目录加载中">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 sm:mb-5">
          <div className="h-5 w-64 max-w-full bg-[var(--public-surface-strong)] sm:h-6" />
          <div className="h-4 w-16 shrink-0 bg-[var(--public-surface-soft)]" />
        </div>

        <div className="space-y-8 sm:space-y-9">
          {[0, 1, 2].map((sectionIndex) => (
            <section key={sectionIndex} className="space-y-4">
              <div className="h-6 w-32 bg-[var(--public-surface-strong)] sm:h-7 sm:w-40" />
              <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
                {[0, 1, 2].map((cardIndex) => (
                  <div key={cardIndex} className="border border-[var(--public-hairline)] bg-[var(--public-surface-soft)] p-4 sm:p-5">
                    <div className="mb-3 h-10 w-10 bg-[var(--public-surface-strong)]" />
                    <div className="mb-2 h-5 w-3/4 bg-[var(--public-surface-strong)]" />
                    <div className="h-4 w-full bg-[var(--public-surface-soft)]" />
                    <div className="mt-2 h-4 w-2/3 bg-[var(--public-surface-soft)]" />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </PublicPageShell>
  )
}