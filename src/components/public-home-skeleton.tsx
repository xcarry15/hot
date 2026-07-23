import PublicFooter from '@/components/public-footer'
import PublicHeader from '@/components/public-header'

export default function PublicHomeSkeleton() {
  return (
    <div className="public-site flex min-h-[100dvh] flex-col bg-background text-foreground">
      <PublicHeader active="articles" />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-3 py-4 sm:px-6 sm:py-8">
        <div className="motion-safe:animate-pulse" aria-busy="true" aria-label="文章列表加载中">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 sm:mb-5 sm:gap-4">
            <div className="h-8 w-28 bg-[var(--public-surface-strong)] sm:h-10 sm:w-36" />
            <div className="flex w-full min-w-0 items-center gap-2 sm:ml-auto sm:w-auto">
              <div className="h-9 min-w-0 flex-1 bg-[var(--public-surface-soft)] sm:w-[280px] sm:flex-none" />
              <div className="h-9 w-14 shrink-0 bg-[var(--public-surface-strong)] sm:w-16" />
            </div>
          </div>

          <div className="h-8 w-28 bg-[var(--public-surface-strong)]" />
          <ol className="mt-1">
            {[0, 1, 2, 3].map((item) => (
              <li key={item} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-2 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-5">
                <div className="pt-3 sm:pt-5"><div className="ml-auto h-3 w-8 bg-[var(--public-surface-soft)] sm:w-10" /></div>
                <div className="relative border-l border-[var(--public-hairline)] pb-3 pl-3 pt-0.5 sm:pb-5 sm:pl-6 sm:pt-1">
                  <span className="absolute left-[-4px] top-4 h-2.5 w-2.5 rounded-full border-2 border-[var(--public-canvas)] bg-[var(--public-hairline-strong)] sm:left-[-5px] sm:top-5" />
                  <div className="px-2.5 py-3 sm:px-5 sm:py-5">
                    <div className="h-4 w-52 max-w-full bg-[var(--public-surface-strong)]" />
                    <div className="mt-2 h-6 w-full bg-[var(--public-surface-strong)] sm:mt-3 sm:h-7 sm:w-4/5" />
                    <div className="mt-2 h-4 w-full bg-[var(--public-surface-soft)] sm:mt-3" />
                    <div className="mt-1.5 h-4 w-3/4 bg-[var(--public-surface-soft)] sm:mt-2" />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </main>
      <PublicFooter />
    </div>
  )
}
