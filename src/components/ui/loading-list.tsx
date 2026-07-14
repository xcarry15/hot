import { Skeleton } from '@/components/ui/skeleton'

/** 统一列表加载骨架屏，消除各页面重复的 Skeleton 数组 */
export function LoadingList({ count = 5, className = 'h-12 w-full' }: { count?: number; className?: string }) {
  return (
    <div className="p-3 space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={className} />
      ))}
    </div>
  )
}
