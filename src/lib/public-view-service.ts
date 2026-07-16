import { db } from '@/lib/db'

const VIEW_FLUSH_DELAY_MS = 1_000
const pendingViews = new Map<string, number>()
let flushTimer: NodeJS.Timeout | null = null
let beforeExitHookRegistered = false

function registerBeforeExitFlush() {
  if (beforeExitHookRegistered || typeof process === 'undefined') return
  beforeExitHookRegistered = true
  process.once('beforeExit', () => {
    void flushPublicArticleViews()
  })
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPublicArticleViews()
  }, VIEW_FLUSH_DELAY_MS)
}

export function enqueuePublicArticleView(articleId: string): void {
  registerBeforeExitFlush()
  pendingViews.set(articleId, (pendingViews.get(articleId) ?? 0) + 1)
  scheduleFlush()
}

export async function flushPublicArticleViews(): Promise<void> {
  if (pendingViews.size === 0) return
  const batch = new Map(pendingViews)
  pendingViews.clear()

  for (const [articleId, count] of batch) {
    try {
      await db.article.update({ where: { id: articleId }, data: { viewCount: { increment: count } } })
    } catch {
      // 文章可能已被删除；浏览统计不应阻塞公开页面或反复重试写入。
    }
  }

  if (pendingViews.size > 0) scheduleFlush()
}
