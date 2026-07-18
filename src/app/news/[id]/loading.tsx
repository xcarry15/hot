import PublicFooter from '@/components/public-footer'
import PublicHeader from '@/components/public-header'
import { Skeleton } from '@/components/ui/skeleton'

export default function PublicNewsDetailLoading() {
  return (
    <div className="public-site flex min-h-[100dvh] flex-col bg-background">
      <PublicHeader active="articles" />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <div className="mx-auto max-w-[840px] space-y-5" aria-label="文章加载中">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-10 w-5/6" />
          <Skeleton className="h-5 w-2/5" />
          <div className="space-y-3 border-t pt-6">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-4/5" />
          </div>
          <Skeleton className="h-48 w-full" />
        </div>
      </main>
      <PublicFooter />
    </div>
  )
}
