import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPENROUTER_FREE_COOLDOWN_MS,
  OPENROUTER_FREE_REQUEST_INTERVAL_MS,
  getAIRateLimitCooldownRemainingMs,
  noteAIRateLimit,
  resetAIRateGateForTests,
  waitForAIRequestSlot,
} from '@/lib/ai-rate-gate';
import {
  getAIModelValidationError,
  isAIModelAllowed,
  isFreeAIModel as isProviderFreeAIModel,
  isOpenRouterFreeModel,
} from '@/contracts/ai-provider';

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


  it('Provider 模型策略允许 DeepSeek，拒绝免费 Provider 的付费模型', () => {
    expect(isAIModelAllowed('deepseek', 'deepseek-v4-flash')).toBe(true);
    expect(isAIModelAllowed('openrouter', 'openai/gpt-4o')).toBe(false);
    expect(isProviderFreeAIModel('openrouter', 'openrouter/free')).toBe(true);
  });

  it('拒绝对象原型名称，避免损坏 Provider 配置解析', () => {
    expect(isAIModelAllowed('constructor', 'anything')).toBe(false);
    expect(getAIModelValidationError('constructor', 'anything')).toBe('不支持的 AI Provider');
  });

});
