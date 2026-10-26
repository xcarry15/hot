import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollModelHealth, readModelHealth, type ModelHealthSnapshot } from '@/features/ai-model-health.client';
import type { testSavedAiModel } from '@/features/settings-api.client';

const initial = (): ModelHealthSnapshot => ({
  models: ['first:free', 'second:free'], completed: 0, results: {}, cooldownUntil: 0,
});

describe('模型可用性轮测', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('单个模型失败继续测试下一项，并持久化结果', async () => {
    const probe = vi.fn<typeof testSavedAiModel>()
      .mockResolvedValueOnce({ success: false, errorKind: 'provider', status: 503 })
      .mockResolvedValueOnce({ success: true, latencyMs: 100 });
    const result = await pollModelHealth(initial(), new AbortController().signal, vi.fn(), probe);
    expect(probe.mock.calls.map(call => call[1])).toEqual(['first:free', 'second:free']);
    expect(result.completed).toBe(2);
    expect(readModelHealth()).toEqual(result);
    expect(result.results['first:free'].success).toBe(false);
    expect(result.results['second:free'].success).toBe(true);
  });

  it('共享冷却不标红或推进游标，倒计时后恢复原模型', async () => {
    const probe = vi.fn<typeof testSavedAiModel>()
      .mockResolvedValueOnce({ success: false, errorKind: 'rate_limit', retryAfterMs: 90_000, requestStarted: false })
      .mockResolvedValue({ success: true });
    const pending = pollModelHealth(initial(), new AbortController().signal, vi.fn(), probe);
    await vi.advanceTimersByTimeAsync(0);
    expect(readModelHealth().completed).toBe(0);
    expect(readModelHealth().results).toEqual({});
    await vi.advanceTimersByTimeAsync(89_999);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).completed).toBe(2);
    expect(probe.mock.calls.map(call => call[1])).toEqual(['first:free', 'first:free', 'second:free']);
  });

  it('实际模型限流单独记录，等待后继续下一个模型', async () => {
    const probe = vi.fn<typeof testSavedAiModel>()
      .mockResolvedValueOnce({ success: false, errorKind: 'rate_limit', status: 429, requestStarted: true })
      .mockResolvedValueOnce({ success: true });
    const pending = pollModelHealth(initial(), new AbortController().signal, vi.fn(), probe);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).completed).toBe(2);
    expect(probe.mock.calls[1][1]).toBe('second:free');
  });

  it('停止冷却等待后不再请求，保存进度可续测', async () => {
    const controller = new AbortController();
    const probe = vi.fn<typeof testSavedAiModel>()
      .mockResolvedValue({ success: false, errorKind: 'rate_limit', requestStarted: false });
    const pending = pollModelHealth(initial(), controller.signal, vi.fn(), probe);
    const stopped = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await stopped;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(readModelHealth().completed).toBe(0);
    const resumedProbe = vi.fn<typeof testSavedAiModel>().mockResolvedValue({ success: true });
    expect((await pollModelHealth(readModelHealth(), new AbortController().signal, vi.fn(), resumedProbe)).completed).toBe(2);
  });

  it('取消正在请求的模型不保存迟到结果', async () => {
    const controller = new AbortController();
    const probe = vi.fn<typeof testSavedAiModel>().mockImplementation(async (_provider, _model, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return { success: true };
    });
    const result = await pollModelHealth(initial(), controller.signal, vi.fn(), probe);
    expect(result.completed).toBe(0);
    expect(result.results).toEqual({});
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('配置失败暂停，剩余模型不被标成失败', async () => {
    const probe = vi.fn<typeof testSavedAiModel>().mockResolvedValue({ success: false, errorKind: 'configuration', error: 'Key 无效' });
    await expect(pollModelHealth(initial(), new AbortController().signal, vi.fn(), probe)).rejects.toThrow('Key 无效');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(readModelHealth().results).toEqual({});
  });
});
