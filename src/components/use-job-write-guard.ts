'use client';

import { useEffect, useState } from 'react';
import { fetchCrawlLogJobStatus } from '@/features/crawl-log-api.client';

/** 只提供写入前提示；服务端独占保护仍是最终判断。 */
export function useJobWriteGuard(enabled: boolean): boolean {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const result = await fetchCrawlLogJobStatus(controller.signal);
        if (!cancelled) setBusy(result.activeJob !== null);
      } catch {
        // 提示请求失败时保留原状态，写入由服务端保护。
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [enabled]);
  return enabled && busy;
}
