import { describe, expect, it } from 'vitest';
import { abortableDelay, withTimeout } from '@/lib/shared/async';

describe('cancellable timeout primitives', () => {
  it('aborts the child signal and prevents a late side effect', async () => {
    let lateWrite = false;

    await expect(withTimeout(async signal => {
      await new Promise(resolve => setTimeout(resolve, 30));
      if (signal.aborted) throw signal.reason;
      lateWrite = true;
    }, 5, 'adversarial timeout')).rejects.toThrow('adversarial timeout');

    await new Promise(resolve => setTimeout(resolve, 40));
    expect(lateWrite).toBe(false);
  });

  it('interrupts retry delays when the parent job is stopped', async () => {
    const controller = new AbortController();
    const waiting = abortableDelay(10_000, controller.signal);
    controller.abort(new Error('Stopped by user'));

    await expect(waiting).rejects.toThrow('Stopped by user');
  });
});
