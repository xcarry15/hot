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
    let timer: number | undefined;
    let currentlyBusy = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (cancelled || inFlight || document.visibilityState === 'hidden') return;
      window.clearTimeout(timer);
      inFlight = true;
      try {
        const result = await fetchCrawlLogJobStatus(controller.signal);
        if (!cancelled) {
          currentlyBusy = result.activeJob !== null;
          setBusy(currentlyBusy);
        }
      } catch {
        // 提示请求失败时保留原状态，写入由服务端保护。
      } finally {
        inFlight = false;
        if (!cancelled) {
          timer = window.setTimeout(() => void refresh(), currentlyBusy ? 3000 : 15_000);
        }
      }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [enabled]);
  return enabled && busy;
}
