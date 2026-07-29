import { db } from '@/lib/db'

const VIEW_FLUSH_DELAY_MS = 1_000
type PublicViewState = {
  pendingViews: Map<string, number>
  pendingOriginalClicks: Map<string, number>
  flushTimer: NodeJS.Timeout | null
  beforeExitHookRegistered: boolean
}

const globalForPublicViews = globalThis as typeof globalThis & {
  __hot2PublicViewState?: PublicViewState
}

const state = globalForPublicViews.__hot2PublicViewState ?? {
  pendingViews: new Map<string, number>(),
  pendingOriginalClicks: new Map<string, number>(),
  flushTimer: null,
  beforeExitHookRegistered: false,
}

// 开发热更新可能复用旧 global 状态，补齐新增字段而不是要求重启进程。
state.pendingOriginalClicks ??= new Map<string, number>()

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

export function enqueuePublicArticleOriginalClick(articleId: string): void {
  registerBeforeExitFlush()
  state.pendingOriginalClicks.set(articleId, (state.pendingOriginalClicks.get(articleId) ?? 0) + 1)
  scheduleFlush()
}

export async function flushPublicArticleViews(): Promise<void> {
  if (state.pendingViews.size === 0 && state.pendingOriginalClicks.size === 0) return
  const viewBatch = new Map(state.pendingViews)
  const clickBatch = new Map(state.pendingOriginalClicks)
  state.pendingViews.clear()
  state.pendingOriginalClicks.clear()

  try {
    await db.$transaction([
      ...[...viewBatch].map(([articleId, count]) => (
        // 互动计数不属于内容变更，绕过 Prisma @updatedAt，避免 sitemap 的
        // lastModified 被每次浏览刷新并向搜索引擎发送错误信号。
        db.$executeRaw`
          UPDATE "articles"
          SET "viewCount" = "viewCount" + ${count}
          WHERE "id" = ${articleId}
        `
      )),
      ...[...clickBatch].map(([articleId, count]) => db.$executeRaw`
        UPDATE "articles"
        SET "originalClickCount" = "originalClickCount" + ${count}
        WHERE "id" = ${articleId}
      `),
    ]);
  } catch {
    // UPDATE 找不到已删除文章时不会抛错；这里只需要把瞬时数据库错误
    // 的计数放回队列，避免 SQLite 写锁冲突直接吞掉真实浏览量。
    for (const [articleId, count] of viewBatch) {
      state.pendingViews.set(articleId, (state.pendingViews.get(articleId) ?? 0) + count)
    }
    for (const [articleId, count] of clickBatch) {
      state.pendingOriginalClicks.set(articleId, (state.pendingOriginalClicks.get(articleId) ?? 0) + count)
    }
  }

  if (state.pendingViews.size > 0 || state.pendingOriginalClicks.size > 0) scheduleFlush()
}
