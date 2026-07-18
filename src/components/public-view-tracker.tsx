'use client'

import { useEffect } from 'react'

const VIEW_CONFIRM_DELAY_MS = 800

export default function PublicViewTracker({ articleId }: { articleId: string }) {
  useEffect(() => {
    // 只有页面真实挂载并停留片刻才计数；路由预取和快速跳过不算浏览。
    const timer = window.setTimeout(() => {
      void fetch(`/api/public/articles/${articleId}/view`, {
        method: 'POST',
        keepalive: true,
      })
    }, VIEW_CONFIRM_DELAY_MS)

    return () => window.clearTimeout(timer)
  }, [articleId])

  return null
}
