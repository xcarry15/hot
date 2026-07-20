import PublicFooter from '@/components/public-footer'
import PublicHeader from '@/components/public-header'

export default function PublicHomeSkeleton() {
  return (
    <div className="public-site flex min-h-[100dvh] flex-col bg-background text-foreground">
      <PublicHeader active="articles" />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-5 sm:px-6 sm:py-8">
        <div className="motion-safe:animate-pulse" aria-busy="true" aria-label="文章列表加载中">
          <div className="mb-5 flex items-center justify-between gap-4">
            <div className="h-10 w-36 bg-[var(--public-surface-strong)]" />
            <div className="ml-auto flex items-center gap-2">
              <div className="h-9 w-[180px] bg-[var(--public-surface-soft)] sm:w-[280px]" />
              <div className="h-9 w-16 bg-[var(--public-surface-strong)]" />
            </div>
          </div>

          <div className="h-8 w-28 bg-[var(--public-surface-strong)]" />
          <ol className="mt-1">
            {[0, 1, 2, 3].map((item) => (
              <li key={item} className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-5">
                <div className="pt-5"><div className="ml-auto h-3 w-10 bg-[var(--public-surface-soft)]" /></div>
                <div className="relative border-l border-[var(--public-hairline)] pb-4 pl-4 pt-1 sm:pb-5 sm:pl-6">
                  <span className="absolute left-[-5px] top-5 h-2.5 w-2.5 rounded-full border-2 border-[var(--public-canvas)] bg-[var(--public-hairline-strong)]" />
                  <div className="px-4 py-4 sm:px-5 sm:py-5">
                    <div className="h-4 w-52 max-w-full bg-[var(--public-surface-strong)]" />
                    <div className="mt-3 h-7 w-4/5 bg-[var(--public-surface-strong)]" />
                    <div className="mt-3 h-4 w-full bg-[var(--public-surface-soft)]" />
                    <div className="mt-2 h-4 w-3/4 bg-[var(--public-surface-soft)]" />
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
