function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Operation aborted')
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) onParentAbort()
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(`${label} (${timeoutMs / 1000}s)`)), timeoutMs)
  const task = Promise.resolve().then(() => operation(controller.signal))
  const aborted = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) {
      reject(abortError(controller.signal))
      return
    }
    controller.signal.addEventListener('abort', () => reject(abortError(controller.signal)), { once: true })
  })
  try {
    return await Promise.race([task, aborted])
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', onParentAbort)
  }
}

