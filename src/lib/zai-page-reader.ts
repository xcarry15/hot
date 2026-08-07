import { getZAI } from './zai';
import { withTimeout } from './shared/async';
import { assertSafeOutboundUrl } from './outbound-url';
import { assertNotAborted } from './worker-stop';

const PAGE_READER_TIMEOUT_MS = 30_000;
const PAGE_READER_MAX_IN_FLIGHT = 2;

type PageReaderWaiter = {
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
};

let pageReaderInFlight = 0;
const pageReaderWaiters: PageReaderWaiter[] = [];

function pageReaderAbortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Operation aborted');
}

function releasePageReaderSlot(): void {
  pageReaderInFlight = Math.max(0, pageReaderInFlight - 1);
  while (pageReaderWaiters.length > 0) {
    const waiter = pageReaderWaiters.shift()!;
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    if (waiter.signal?.aborted) {
      waiter.reject(pageReaderAbortError(waiter.signal));
      continue;
    }
    pageReaderInFlight++;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      releasePageReaderSlot();
    });
    return;
  }
}

function acquirePageReaderSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(pageReaderAbortError(signal));
  if (pageReaderInFlight < PAGE_READER_MAX_IN_FLIGHT) {
    pageReaderInFlight++;
    let released = false;
    return Promise.resolve(() => {
      if (released) return;
      released = true;
      releasePageReaderSlot();
    });
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: PageReaderWaiter = {
      signal,
      resolve,
      reject,
      onAbort: () => {
        const index = pageReaderWaiters.indexOf(waiter);
        if (index >= 0) pageReaderWaiters.splice(index, 1);
        reject(pageReaderAbortError(signal));
      },
    };
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    pageReaderWaiters.push(waiter);
  });
}

export async function readZaiPage(
  url: string,
  signal?: AbortSignal,
): Promise<{ data?: { html?: string } }> {
  assertNotAborted(signal);
  await assertSafeOutboundUrl(url);
  const zai = await getZAI();
  const release = await acquirePageReaderSlot(signal);
  const remote = Promise.resolve().then(() => zai.functions.invoke('page_reader', { url }));
  // SDK 当前不接受 AbortSignal。超时只结束本地等待，但槽位要一直占用到
  // 远程 Promise 真正 settled，避免连续重试堆积无限悬挂调用。
  const settled = remote.finally(release);
  return withTimeout(
    timeoutSignal => settled.then((value) => {
      assertNotAborted(timeoutSignal);
      return value;
    }),
    PAGE_READER_TIMEOUT_MS,
    `ZAI page_reader timeout: ${url}`,
    signal,
  );
}
