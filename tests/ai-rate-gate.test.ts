import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPENCODE_FREE_COOLDOWN_MS,
  OPENCODE_FREE_REQUEST_INTERVAL_MS,
  OPENROUTER_FREE_COOLDOWN_MS,
  OPENROUTER_FREE_REQUEST_INTERVAL_MS,
  getAIRateLimitCooldownRemainingMs,
  isFreeAIModel,
  noteAIRateLimit,
  resetAIRateGateForTests,
  waitForAIRequestSlot,
} from '@/lib/ai-rate-gate';
import { isOpenRouterFreeModel } from '@/contracts/ai-provider';

describe('OpenRouter 免费模型请求闸门', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAIRateGateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('只识别 OpenRouter 免费路由和 :free 模型', () => {
    expect(isOpenRouterFreeModel('openrouter/free')).toBe(true);
    expect(isOpenRouterFreeModel('meta-llama/example:free')).toBe(true);
    expect(isOpenRouterFreeModel('openai/gpt-4o')).toBe(false);
  });

  it('把连续免费请求串行化，并至少间隔 3 秒', async () => {
    await waitForAIRequestSlot('openrouter', 'openrouter/free');
    let secondFinished = false;
    const second = waitForAIRequestSlot('openrouter', 'openrouter/free').then(() => {
      secondFinished = true;
    });

    await vi.advanceTimersByTimeAsync(OPENROUTER_FREE_REQUEST_INTERVAL_MS - 1);
    expect(secondFinished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(secondFinished).toBe(true);
  });

  it('429 后至少冷却 60 秒', async () => {
    await waitForAIRequestSlot('openrouter', 'openrouter/free');
    noteAIRateLimit('openrouter', 'openrouter/free');
    let secondFinished = false;
    const second = waitForAIRequestSlot('openrouter', 'openrouter/free').then(() => {
      secondFinished = true;
    });

    await vi.advanceTimersByTimeAsync(OPENROUTER_FREE_COOLDOWN_MS - 1);
    expect(secondFinished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(secondFinished).toBe(true);
  });

  it('可以读取当前免费模型的剩余冷却时间', async () => {
    await waitForAIRequestSlot('openrouter', 'openrouter/free');
    noteAIRateLimit('openrouter', 'openrouter/free');

    expect(getAIRateLimitCooldownRemainingMs('openrouter', 'openrouter/free')).toBe(OPENROUTER_FREE_COOLDOWN_MS);
    await vi.advanceTimersByTimeAsync(OPENROUTER_FREE_COOLDOWN_MS);
    expect(getAIRateLimitCooldownRemainingMs('openrouter', 'openrouter/free')).toBe(0);
  });

  it('识别 OpenCode 免费模型，并拒绝付费模型', () => {
    expect(isFreeAIModel('opencode', 'big-pickle')).toBe(true);
    expect(isFreeAIModel('opencode', 'mimo-v2.5-free')).toBe(true);
    expect(isFreeAIModel('opencode', 'deepseek-v4')).toBe(false);
  });

  it('OpenCode 免费请求串行化，并在 429 后冷却 60 秒', async () => {
    await waitForAIRequestSlot('opencode', 'big-pickle');
    let secondFinished = false;
    const second = waitForAIRequestSlot('opencode', 'big-pickle').then(() => {
      secondFinished = true;
    });

    await vi.advanceTimersByTimeAsync(OPENCODE_FREE_REQUEST_INTERVAL_MS - 1);
    expect(secondFinished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;

    noteAIRateLimit('opencode', 'big-pickle');
    let thirdFinished = false;
    const third = waitForAIRequestSlot('opencode', 'big-pickle').then(() => {
      thirdFinished = true;
    });

    await vi.advanceTimersByTimeAsync(OPENCODE_FREE_COOLDOWN_MS - 1);
    expect(thirdFinished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await third;
    expect(thirdFinished).toBe(true);
  });
});
