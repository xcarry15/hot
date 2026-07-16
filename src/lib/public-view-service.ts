import { db } from '@/lib/db'

const VIEW_FLUSH_DELAY_MS = 1_000
type PublicViewState = {
  pendingViews: Map<string, number>
  flushTimer: NodeJS.Timeout | null
  beforeExitHookRegistered: boolean
}

const globalForPublicViews = globalThis as typeof globalThis & {
  __hot2PublicViewState?: PublicViewState
}

const state = globalForPublicViews.__hot2PublicViewState ?? {
  pendingViews: new Map<string, number>(),
  flushTimer: null,
  beforeExitHookRegistered: false,
}

globalForPublicViews.__hot2PublicViewState = state

function registerBeforeExitFlush() {
  if (state.beforeExitHookRegistered || typeof process === 'undefined') return
  state.beforeExitHookRegistered = true
  process.once('beforeExit', () => {
    void flushPublicArticleViews()
  })
}

function scheduleFlush() {
  if (state.flushTimer) return
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null
    void flushPublicArticleViews()
  }, VIEW_FLUSH_DELAY_MS)
}

export function enqueuePublicArticleView(articleId: string): void {
  registerBeforeExitFlush()
  state.pendingViews.set(articleId, (state.pendingViews.get(articleId) ?? 0) + 1)
  scheduleFlush()
}

export async function flushPublicArticleViews(): Promise<void> {
  if (state.pendingViews.size === 0) return
  const batch = new Map(state.pendingViews)
  state.pendingViews.clear()

  for (const [articleId, count] of batch) {
    try {
      await db.article.update({ where: { id: articleId }, data: { viewCount: { increment: count } } })
    } catch {
      // 文章可能已被删除；浏览统计不应阻塞公开页面或反复重试写入。
    }
  }

  if (state.pendingViews.size > 0) scheduleFlush()
}
