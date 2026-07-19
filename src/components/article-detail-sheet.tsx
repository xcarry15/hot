'use client'

import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchDiscardedItem } from '@/features/discarded-api.client'
import { isRequestAborted, isRequestJsonError } from '@/lib/request-json.client'
import { formatRelativeTime } from '@/lib/shared/date'

interface DiscardedDetail {
  id: string
  title: string
  url: string
  reason: string
  parsedDetail: Record<string, unknown> | null
  createdAt: string
  source?: { name: string }
}

export default function DiscardedDetailSheet({
  discardedId,
  open,
  onOpenChange,
}: {
  discardedId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [discarded, setDiscarded] = useState<DiscardedDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<{ notFound: boolean; message: string } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!open || !discardedId) return
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)
    setDiscarded(null)
    fetchDiscardedItem(discardedId, controller.signal)
      .then(value => setDiscarded(value as DiscardedDetail))
      .catch(error => {
        if (isRequestAborted(error)) return
        if (isRequestJsonError(error, 404)) {
          setLoadError({ notFound: true, message: '该记录不存在或已被删除' })
          return
        }
        setLoadError({
          notFound: false,
          message: error instanceof Error ? error.message : '详情加载失败',
        })
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [discardedId, open, reloadKey])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full p-0 sm:max-w-lg">
        <SheetHeader className="border-b p-5 pb-3">
          <SheetTitle className="text-base">未入库诊断</SheetTitle>
          <SheetDescription className="sr-only">查看未入库原因</SheetDescription>
        </SheetHeader>
        <ScrollArea className="h-[calc(100dvh-68px)]">
          {loading ? (
            <div className="space-y-3 p-5">
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : discarded ? (
            <div className="space-y-4 p-5">
              <h3 className="font-semibold leading-snug">{discarded.title}</h3>
              <p className="text-xs text-muted-foreground">
                {discarded.source?.name || '未知来源'} · {formatRelativeTime(discarded.createdAt)}
              </p>
              <Badge variant="outline">未入库：{discarded.reason}</Badge>
              {discarded.parsedDetail && (
                <pre className="overflow-auto whitespace-pre-wrap border bg-muted/30 p-3 text-xs">
                  {JSON.stringify(discarded.parsedDetail, null, 2)}
                </pre>
              )}
              <a href={discarded.url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 border px-3 text-xs">
                <ExternalLink className="h-3.5 w-3.5" />原文
              </a>
            </div>
          ) : loadError ? (
            <div className="space-y-3 p-5 text-sm">
              <p className={loadError.notFound ? 'text-muted-foreground' : 'text-destructive'}>{loadError.message}</p>
              {!loadError.notFound && <Button size="sm" variant="outline" onClick={() => setReloadKey(value => value + 1)}>重试加载</Button>}
            </div>
          ) : (
            <div className="p-5 text-sm text-muted-foreground">暂无详情</div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
