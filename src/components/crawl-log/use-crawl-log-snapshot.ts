'use client'

/**
 * 重构 #4：抓取记录页唯一权威数据 hook。
 *
 * 数据真相来源：`/api/crawl-log/status` 返回的 snapshot（含 activeJob / latestJob / sources）。
 *
 * 触发刷新的来源（按设计 12.8）：
 *   1. 组件首次 mount
 *   2. 任务运行时每 3 秒拉轻量 Job 快照、空闲时每 15 秒刷新完整快照
 *   3. 页面 visibilitychange + focus
 *   4. 手动调用 refreshSnapshot() 与写操作成功后
 *
 * 关键不变量：
 *   - 同一时间只允许一个 snapshot 请求在飞；并发请求时只设置 dirty=true，
 *     当前请求结束后立刻补拉一次。
 *   - 慢响应不能覆盖快响应：用递增 requestId，只应用最后一次响应。
 *   - 不持久化业务运行状态到 sessionStorage。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CrawlLogSnapshot } from '@/contracts/crawl-log'
import { fetchCrawlLogJobStatus, fetchCrawlLogSnapshot } from '@/features/crawl-log-api.client'

export type { CrawlLogSnapshot, JobSnapshot } from '@/contracts/crawl-log'

interface UseCrawlLogSnapshotOptions {
  /** 页面是否处于前台；隐藏但保留挂载时暂停请求。 */
  enabled?: boolean
  /** snapshot 接口 limit，默认 500 */
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
  const { enabled = true, limit = 500, pollIntervalMs = 3000, idlePollIntervalMs = 15_000 } = options

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
  const snapshotRef = useRef<CrawlLogSnapshot | null>(null)
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
      try {
        const data = await fetchCrawlLogSnapshot(limit)
        if (unmountedRef.current) return false
        // 慢响应不能覆盖快响应：只应用最后一次响应。
        if (myRequestId !== requestIdRef.current) return false
        setSnapshot(data)
        snapshotRef.current = data
        setLastSyncedAt(Date.now())
        setError(null)
        return true
      } catch (err: unknown) {
        if (unmountedRef.current) return false
        if (myRequestId !== requestIdRef.current) return false
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        return false
      } finally {
        inFlightRef.current = false
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
            try {
              const jobs = await fetchCrawlLogJobStatus()
              if (!unmountedRef.current) {
                const stageChanged = jobs.activeJob?.currentStage !== current.activeJob.currentStage
                const jobFinished = !jobs.activeJob
                if (stageChanged || jobFinished) {
                  await refreshSnapshotRefForPolling.current()
                } else {
                  const next = { ...current, activeJob: jobs.activeJob, latestJob: jobs.latestJob, fetchedAt: jobs.fetchedAt }
                  snapshotRef.current = next
                  setSnapshot(next)
                  setLastSyncedAt(Date.now())
                }
              }
            } catch {
              // 轻快照失败不清空已有页面，下一轮继续。
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
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [enabled, idlePollIntervalMs, pollIntervalMs, refreshSnapshot])

  // 2) visibilitychange + focus —— 重新可见/聚焦时拉一次
  useEffect(() => {
    if (!enabled) return
    function onVisible() {
      if (document.visibilityState === 'visible') {
        void refreshSnapshot()
      }
    }
    function onFocus() {
      void refreshSnapshot()
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
