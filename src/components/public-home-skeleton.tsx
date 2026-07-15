import PublicFooter from '@/components/public-footer'
import PublicHeader from '@/components/public-header'

export default function PublicHomeSkeleton() {
  return (
    <div className="public-site flex min-h-[100dvh] flex-col bg-background text-foreground">
      <PublicHeader active="articles" />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <div className="motion-safe:animate-pulse">
          <div className="h-3 w-20 rounded bg-[var(--public-surface-strong)]" />
          <div className="mt-4 h-10 w-44 rounded bg-[var(--public-surface-strong)]" />
          <div className="mt-3 h-5 w-80 max-w-full rounded bg-[var(--public-surface-soft)]" />
          <div className="mt-8 rounded-xl border border-[var(--public-hairline)] bg-[var(--public-surface)] p-5">
            <div className="h-10 rounded bg-[var(--public-surface-soft)]" />
            <div className="mt-4 h-9 w-72 max-w-full rounded bg-[var(--public-surface-soft)]" />
          </div>
          <div className="mt-10 space-y-8">
            {[0, 1].map((group) => (
              <section key={group}>
                <div className="h-8 w-52 rounded bg-[var(--public-surface-strong)]" />
                <div className="mt-4 space-y-3 pl-16 sm:pl-24">
                  {[0, 1, 2].map((item) => <div key={item} className="h-28 rounded-lg bg-[var(--public-surface)]" />)}
                </div>
              </section>
            ))}
          </div>
        </div>
      </main>
      <PublicFooter />
    </div>
  )
}
