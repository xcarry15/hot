// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useJobWriteGuard } from '@/components/use-job-write-guard';

const fetchStatus = vi.hoisted(() => vi.fn());
vi.mock('@/features/crawl-log-api.client', () => ({ fetchCrawlLogJobStatus: fetchStatus }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); document.body.innerHTML = ''; });

it('任务结束后及时恢复审核按钮', async () => {
  vi.useFakeTimers();
  fetchStatus.mockResolvedValueOnce({ activeJob: { id: 'job' } }).mockResolvedValue({ activeJob: null });
  function ReviewButton() {
    return <button disabled={useJobWriteGuard(true)}>审核与发布</button>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ReviewButton />));
    expect(container.querySelector('button')!.disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(container.querySelector('button')!.disabled).toBe(false);
  } finally {
    act(() => root.unmount());
  }
});

it('状态请求失败时保留保护并按繁忙间隔重试', async () => {
  vi.useFakeTimers();
  fetchStatus.mockResolvedValueOnce({ activeJob: { id: 'job' } })
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue({ activeJob: null });
  function ReviewButton() { return <button disabled={useJobWriteGuard(true)}>审核</button>; }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ReviewButton />));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(container.querySelector('button')!.disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(container.querySelector('button')!.disabled).toBe(false);
  } finally { act(() => root.unmount()); }
});

it('未完成的状态请求不会并发重复发出，卸载后不再轮询', async () => {
  vi.useFakeTimers();
  let resolve!: (value: { activeJob: null }) => void;
  fetchStatus.mockImplementation(() => new Promise(done => { resolve = done; }));
  function ReviewButton() { return <button disabled={useJobWriteGuard(true)}>审核</button>; }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ReviewButton />));
  await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(30000); });
  expect(fetchStatus).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
  await act(async () => { resolve({ activeJob: null }); await vi.advanceTimersByTimeAsync(30000); });
  expect(fetchStatus).toHaveBeenCalledTimes(1);
});
