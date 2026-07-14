/**
 * ai-client.ts 功能测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  readAllSettings: vi.fn(),
}));

vi.mock('@/lib/settings', () => ({
  readAllSettings: mocks.readAllSettings,
  SETTING_KEYS: {
    AI_PROVIDER: 'ai_provider',
    AI_TEMPERATURE: 'ai_temperature',
    AI_MAX_TOKENS: 'ai_max_tokens',
    AI_SYSTEM_PROMPT: 'ai_system_prompt',
    AI_WEIGHT_EVENT: 'ai_weight_event',
    AI_WEIGHT_CONTENT: 'ai_weight_content',
    AI_STEP2_CONTENT_MAX_CHARS: 'ai_step2_content_max_chars',
  },
}));

import { createChatCompletion, getAISettings, invalidateAISettingsCache } from '@/lib/ai-client';

function collectComponentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectComponentFiles(entryPath);
    return /\.(ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

it('客户端组件不直接依赖服务端 ai-client', () => {
  const componentsDir = path.resolve(__dirname, '../src/components');
  const violations = collectComponentFiles(componentsDir).filter((filePath) => {
    const source = readFileSync(filePath, 'utf8');
    return /(?:@\/lib\/ai-client|\.\.\/lib\/ai-client|\.\/lib\/ai-client)/.test(source);
  });

  expect(violations).toEqual([]);
});

describe('createChatCompletion', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    invalidateAISettingsCache();
    mocks.readAllSettings.mockResolvedValue({
      ai_provider: 'opencode',
      opencode_api_key: 'test-key',
      opencode_base_url: 'https://opencode.ai/zen/v1',
      opencode_model: 'big-pickle',
      ai_temperature: '0.2',
      ai_max_tokens: '10240',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const makeOkResponse = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('正常返回 content', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(makeOkResponse('hello'));

    const res = await createChatCompletion([{ role: 'user', content: 'hi' }]);
    expect(res.content).toBe('hello');
  });

  it('只读取当前 provider 配置，不再读取旧版全局配置', async () => {
    mocks.readAllSettings.mockResolvedValueOnce({
      ai_provider: 'opencode',
      ai_api_key: 'legacy-key',
      ai_base_url: 'https://legacy.example/v1',
      ai_model: 'legacy-model',
    });
    await expect(getAISettings()).resolves.toMatchObject({
      apiKey: '',
      baseUrl: 'https://opencode.ai/zen/v1',
      model: 'big-pickle',
    });

    invalidateAISettingsCache();
    mocks.readAllSettings.mockResolvedValueOnce({
      ai_provider: 'opencode',
      opencode_api_key: '',
      opencode_base_url: '',
      opencode_model: '',
      ai_api_key: 'legacy-key',
      ai_base_url: 'https://legacy.example/v1',
      ai_model: 'legacy-model',
    });
    await expect(getAISettings()).resolves.toMatchObject({
      apiKey: '',
      baseUrl: 'https://opencode.ai/zen/v1',
      model: 'big-pickle',
    });
  });

  it('429 时重试并最终成功', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limit', { status: 429 }))
      .mockResolvedValueOnce(makeOkResponse('ok'));

    const promise = createChatCompletion([{ role: 'user', content: 'hi' }]);
    await vi.advanceTimersByTimeAsync(5000);
    const res = await promise;
    expect(res.content).toBe('ok');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('5xx 时重试并在仍失败后抛出服务端不可用', async () => {
    global.fetch = vi.fn().mockImplementation(() => new Response('server error', { status: 503 }));

    // 立即挂上 rejection 处理器，避免 advanceTimers 期间产生 unhandled rejection
    const assertion = expect(createChatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow('服务暂不可用');
    // 跳过三次重试等待（初始 + 2 次重试）
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('网络错误时重试并最终失败', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

    const assertion = expect(createChatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow('无法连接 API 服务器');
    // 跳过三次重试等待（初始 + 2 次重试）
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('401 直接抛出鉴权失败', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('unauth', { status: 401 }));

    await expect(createChatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'API Key 无效或鉴权失败'
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('最终错误文案不再是固定的"请求频率超限"', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));

    await expect(createChatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow('API 错误 (400)');
  });
});
