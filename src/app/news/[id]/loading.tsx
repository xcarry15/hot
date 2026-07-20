import PublicFooter from '@/components/public-footer'
import PublicHeader from '@/components/public-header'
import { Skeleton } from '@/components/ui/skeleton'

export default function PublicNewsDetailLoading() {
  return (
    <div className="public-site flex min-h-[100dvh] flex-col bg-background">
      <PublicHeader active="articles" />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <div className="mx-auto max-w-[840px]" aria-busy="true" aria-label="文章加载中">
          <Skeleton className="h-5 w-28 rounded-none" />
          <article className="mt-6 px-0 sm:px-8">
            <Skeleton className="h-4 w-2/5 rounded-none" />
            <div className="mt-3 space-y-2">
              <Skeleton className="h-10 w-5/6 rounded-none" />
              <Skeleton className="h-10 w-3/5 rounded-none" />
            </div>
            <div className="mt-4 flex gap-2">
              <Skeleton className="h-6 w-10 rounded-none" />
              <Skeleton className="h-6 w-16 rounded-none" />
              <Skeleton className="h-6 w-20 rounded-none" />
            </div>
            <div className="mt-6 grid gap-4 border-t border-[var(--public-hairline)] pt-5 md:grid-cols-2">
              <Skeleton className="h-56 w-full rounded-none" />
              <Skeleton className="h-56 w-full rounded-none" />
            </div>
          </article>
        </div>
      </main>
      <PublicFooter />
    </div>
  )
}
