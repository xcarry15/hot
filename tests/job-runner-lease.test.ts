import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ upsert: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { setting: mocks } }));
import { acquireJobRunnerLease } from '@/lib/job-runner-lease';

let storedValue: string;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
  storedValue = '';
  mocks.upsert.mockResolvedValue({});
  mocks.findUnique.mockImplementation(async () => ({ value: storedValue }));
  mocks.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.value !== storedValue) return { count: 0 };
    storedValue = data.value;
    return { count: 1 };
  });
});
afterEach(() => { vi.useRealTimers(); });

function pauseNextRenewal() {
  let resume!: () => void;
  const reply = new Promise<void>((resolve) => { resume = resolve; });
  mocks.updateMany.mockImplementationOnce(async ({ where, data }) => {
    if (where.value !== storedValue) return { count: 0 };
    storedValue = data.value;
    await reply;
    return { count: 1 };
  });
  vi.setSystemTime(new Date('2026-10-09T00:00:01Z'));
  return resume;
}

describe('全局执行租约的异步交接', () => {
  it('续租已写入但响应迟到时，释放等待新的 CAS 值，避免残留租约', async () => {
    const lease = await acquireJobRunnerLease();
    expect(lease).not.toBeNull();
    const resume = pauseNextRenewal();
    const renewal = lease!.renew();
    const release = lease!.release();
    await Promise.resolve();
    expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    resume();
    await renewal;
    await release;
    expect(storedValue).toBe('');
    await expect(lease!.renew()).resolves.toBe(false);
    await lease!.release();
    expect(mocks.updateMany).toHaveBeenCalledTimes(3);
  });

  it('当前检查按本轮 token 识别租约，不把尚未返回的续租当成执行权丢失', async () => {
    const lease = await acquireJobRunnerLease();
    await expect(lease!.isCurrent()).resolves.toBe(true);
    const resume = pauseNextRenewal();
    const renewal = lease!.renew();
    await expect(lease!.isCurrent()).resolves.toBe(true);
    resume();
    await renewal;
    await lease!.release();
    await expect(lease!.isCurrent()).resolves.toBe(false);
  });

  it('已过期的全局租约不能续租复活，也不能继续通过当前检查', async () => {
    const lease = await acquireJobRunnerLease();
    const before = storedValue;
    vi.setSystemTime(new Date('2026-10-09T00:02:00Z'));
    await expect(lease!.isCurrent()).resolves.toBe(false);
    await expect(lease!.renew()).resolves.toBe(false);
    expect(storedValue).toBe(before);
    const replacement = await acquireJobRunnerLease();
    expect(replacement).not.toBeNull();
    await expect(lease!.isCurrent()).resolves.toBe(false);
    await expect(replacement!.isCurrent()).resolves.toBe(true);
    const replacementValue = storedValue;
    await lease!.release();
    expect(storedValue).toBe(replacementValue);
    await replacement!.release();
  });

  it('并发续租共用正在进行的请求，不因竞争自身 CAS 值而误判失去租约', async () => {
    const lease = await acquireJobRunnerLease();
    const resume = pauseNextRenewal();
    const first = lease!.renew();
    const second = lease!.renew();
    expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    resume();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await lease!.release();
    expect(storedValue).toBe('');
  });

  it('迟到续租和释放不会清掉另一执行器接管的租约', async () => {
    const lease = await acquireJobRunnerLease();
    const resume = pauseNextRenewal();
    const renewal = lease!.renew();
    const release = lease!.release();
    storedValue = '2026-10-09T00:05:00Z|another-runner';
    resume();
    await renewal;
    await release;
    expect(storedValue).toBe('2026-10-09T00:05:00Z|another-runner');
  });

  it('续租失败后仍可释放持有的租约', async () => {
    const lease = await acquireJobRunnerLease();
    mocks.updateMany.mockRejectedValueOnce(new Error('temporary database failure'));
    const renewal = lease!.renew();
    const release = lease!.release();
    await expect(renewal).rejects.toThrow('temporary database failure');
    await release;
    expect(storedValue).toBe('');
  });
});
