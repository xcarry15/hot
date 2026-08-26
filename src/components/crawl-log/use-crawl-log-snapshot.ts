'use client'

/**
 * 重构 #4：任务中心唯一权威数据 hook。
 *
 * 数据真相来源：`/api/crawl-log/status` 返回的 snapshot（含 activeJob / latestJob / sources）。
 *
 * 触发刷新的来源（按设计 12.8）：
 *   1. 组件首次 mount
 *   2. 任务运行时每 3 秒拉轻量 Job 快照、空闲时每 15 秒刷新完整快照
 *   3. 页面 visibilitychange + focus
 *   4. 手动调用 refreshSnapshot()；文章复核详情由抽屉局部刷新，工作台快照由自适应轮询收敛
 *
 * 关键不变量：
 *   - 同一时间只允许一个 snapshot 请求在飞；并发请求时只设置 dirty=true，
 *     当前请求结束后立刻补拉一次。
 *   - 慢响应不能覆盖快响应：用递增 requestId，只应用最后一次响应。
 *   - 不持久化业务运行状态到 sessionStorage。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { CRAWL_LOG_DEFAULT_LIMIT, type CrawlLogSnapshot } from '@/contracts/crawl-log'
import { fetchCrawlLogJobStatus, fetchCrawlLogSnapshot } from '@/features/crawl-log-api.client'
import { isRequestAborted } from '@/lib/request-json.client'

const ATTENTION_REFRESH_MIN_INTERVAL_MS = 1_000
const ATTENTION_SNAPSHOT_MAX_AGE_MS = 5_000

export type { CrawlLogSnapshot, JobSnapshot } from '@/contracts/crawl-log'

interface UseCrawlLogSnapshotOptions {
  /** 页面是否处于前台；隐藏但保留挂载时暂停请求。 */
  enabled?: boolean
  /** snapshot 接口 limit，默认使用工作台最近窗口大小 */
  limit?: number
  /** 兜底轮询间隔（毫秒），默认 3000 */
  pollIntervalMs?: number
  /** 空闲轮询间隔（毫秒），默认 15000 */
  idlePollIntervalMs?: number
}

interface UseCrawlLogSnapshotReturn {
  snapshot: CrawlLogSnapshot | null
  loading: boolean
  error: string | null
  lastSyncedAt: number | null
  refreshSnapshot: () => Promise<boolean>
}

/**
 * 单次拉取 snapshot，返回最新数据或抛错。
 * 抽成模块级函数便于测试。
 */
export { fetchCrawlLogSnapshot }

export function useCrawlLogSnapshot(
  options: UseCrawlLogSnapshotOptions = {},
): UseCrawlLogSnapshotReturn {
  const { enabled = true, limit = CRAWL_LOG_DEFAULT_LIMIT, pollIntervalMs = 3000, idlePollIntervalMs = 15_000 } = options

  const [snapshot, setSnapshot] = useState<CrawlLogSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)

  const inFlightRef = useRef<boolean>(false)
  const dirtyRef = useRef<boolean>(false)
  const requestIdRef = useRef<number>(0)
  const unmountedRef = useRef<boolean>(false)
  const refreshSnapshotRef = useRef<(() => Promise<boolean>) | null>(null)
  const inFlightPromiseRef = useRef<Promise<boolean> | null>(null)
  const requestAbortRef = useRef<AbortController | null>(null)
  const pollingAbortRef = useRef<AbortController | null>(null)
  const snapshotRef = useRef<CrawlLogSnapshot | null>(null)
  const lastSnapshotSyncedAtRef = useRef(0)
  const lastAttentionRefreshAtRef = useRef(0)
  const refreshSnapshotRefForPolling = useRef<() => Promise<boolean>>(async () => false)

  const refreshSnapshot = useCallback(() => {
    if (unmountedRef.current) return Promise.resolve(false)
    if (inFlightRef.current) {
      dirtyRef.current = true
      return inFlightPromiseRef.current ?? Promise.resolve(false)
    }
    const request = (async () => {
      inFlightRef.current = true
      const myRequestId = ++requestIdRef.current
      const controller = new AbortController()
      requestAbortRef.current = controller
      try {
        const data = await fetchCrawlLogSnapshot(limit, controller.signal)
        if (unmountedRef.current) return false
        // 慢响应不能覆盖快响应：只应用最后一次响应。
        if (myRequestId !== requestIdRef.current) return false
        setSnapshot(data)
        snapshotRef.current = data
        const syncedAt = Date.now()
        lastSnapshotSyncedAtRef.current = syncedAt
        setLastSyncedAt(syncedAt)
        setError(null)
        return true
      } catch (err: unknown) {
        if (unmountedRef.current || isRequestAborted(err)) return false
        if (myRequestId !== requestIdRef.current) return false
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        return false
      } finally {
        inFlightRef.current = false
        if (requestAbortRef.current === controller) requestAbortRef.current = null
        // 同一 refresh 调用期间收到新的拉取请求，立即补拉一次。
        if (dirtyRef.current && !unmountedRef.current) {
          dirtyRef.current = false
          // 通过 ref 调度补拉，避免 callback 自递归并保持同一请求门禁。
          void refreshSnapshotRef.current?.()
        } else {
          setLoading(false)
        }
      }
    })()
    inFlightPromiseRef.current = request
    void request.then(() => {
      if (inFlightPromiseRef.current === request) inFlightPromiseRef.current = null
    })
    return request
  }, [limit])

  // Keep the latest callback available to the in-flight request without
  // mutating a ref during render (React Compiler refs rule).
  useEffect(() => {
    refreshSnapshotRef.current = refreshSnapshot
    refreshSnapshotRefForPolling.current = refreshSnapshot
    return () => {
      refreshSnapshotRef.current = null
      refreshSnapshotRefForPolling.current = async () => false
    }
  }, [refreshSnapshot])

  // 1) 首次 mount + 自适应轮询。后台标签页 hidden 时不发周期请求。
  useEffect(() => {
    if (!enabled) return
    unmountedRef.current = false
    void refreshSnapshot()
    let timer: number | undefined
    const schedule = () => {
      const interval = snapshotRef.current?.activeJob ? pollIntervalMs : idlePollIntervalMs
      timer = window.setTimeout(async () => {
        if (document.visibilityState === 'visible') {
          const current = snapshotRef.current
          if (current?.activeJob) {
            // 轻量 Job 请求可能与手动/完整 snapshot 请求并发；若期间
            // 已开始新的完整请求，不能让旧的轻量结果回写覆盖新快照。
            const pollRequestId = requestIdRef.current
            const pollController = new AbortController()
            pollingAbortRef.current = pollController
            const pollTimeout = window.setTimeout(() => pollController.abort(), 10_000)
            try {
              const jobs = await fetchCrawlLogJobStatus(pollController.signal)
              if (!unmountedRef.current && pollRequestId === requestIdRef.current) {
                const jobChanged = jobs.activeJob?.id !== current.activeJob.id
                const stageChanged = jobs.activeJob?.currentStage !== current.activeJob.currentStage
                const jobFinished = !jobs.activeJob
                if (jobChanged || stageChanged || jobFinished) {
                  await refreshSnapshotRefForPolling.current()
                } else {
                  const next = { ...current, activeJob: jobs.activeJob, latestJob: jobs.latestJob, fetchedAt: jobs.fetchedAt }
                  snapshotRef.current = next
                  setSnapshot(next)
                  const syncedAt = Date.now()
                  lastSnapshotSyncedAtRef.current = syncedAt
                  setLastSyncedAt(syncedAt)
                }
              }
            } catch {
              // 轻快照失败不清空已有页面，下一轮继续。
            } finally {
              window.clearTimeout(pollTimeout)
              if (pollingAbortRef.current === pollController) pollingAbortRef.current = null
            }
          } else {
            await refreshSnapshotRefForPolling.current()
          }
        }
        if (!unmountedRef.current) schedule()
      }, interval)
    }
    schedule()
    return () => {
      unmountedRef.current = true
      requestAbortRef.current?.abort()
      pollingAbortRef.current?.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [enabled, idlePollIntervalMs, pollIntervalMs, refreshSnapshot])

  // 2) visibilitychange + focus —— 重新可见/聚焦时按需拉取一次。
  // 浏览器通常会连续派发两个事件；短窗口和新鲜度门槛避免重复拉重快照。
  useEffect(() => {
    if (!enabled) return
    const refreshOnAttention = () => {
      if (document.visibilityState !== 'visible') return
      if (inFlightRef.current || pollingAbortRef.current) return
      const now = Date.now()
      if (now - lastAttentionRefreshAtRef.current < ATTENTION_REFRESH_MIN_INTERVAL_MS) return
      if (
        lastSnapshotSyncedAtRef.current > 0
        && now - lastSnapshotSyncedAtRef.current < ATTENTION_SNAPSHOT_MAX_AGE_MS
      ) return
      lastAttentionRefreshAtRef.current = now
      void refreshSnapshot()
    }
    function onVisible() {
      refreshOnAttention()
    }
    function onFocus() {
      refreshOnAttention()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, refreshSnapshot])

  return { snapshot, loading, error, lastSyncedAt, refreshSnapshot }
}
