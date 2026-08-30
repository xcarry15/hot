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

import { AIClientError, createChatCompletion, getAISettings, invalidateAISettingsCache, testAIConnection } from '@/lib/ai-client';
import { resetAIRateGateForTests } from '@/lib/ai-rate-gate';

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
    resetAIRateGateForTests();
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

  const makeResponsesOkResponse = (content: string) =>
    new Response(JSON.stringify({
      output_text: content,
      output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('正常返回 content', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(makeOkResponse('hello'));

    const res = await createChatCompletion([{ role: 'user', content: 'hi' }]);
    expect(res.content).toBe('hello');
  });

  it('OpenCode Responses 模型使用官方 responses 端点并解析 output_text', async () => {
    mocks.readAllSettings.mockResolvedValueOnce({
      ai_provider: 'opencode',
      opencode_api_key: 'test-key',
      opencode_base_url: 'https://opencode.ai/zen/v1',
      opencode_model: 'muse-spark-1.2-contributor-free',
      ai_temperature: '0.2',
      ai_max_tokens: '10240',
    });
    global.fetch = vi.fn().mockResolvedValueOnce(makeResponsesOkResponse('{"ok":true}'));

    await expect(createChatCompletion([
      { role: 'system', content: 'system rule' },
      { role: 'user', content: 'hi' },
    ])).resolves.toMatchObject({
      content: '{"ok":true}',
      provider: 'opencode',
      model: 'muse-spark-1.2-contributor-free',
    });

    const [requestUrl, requestInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [RequestInfo, RequestInit];
    expect(String(requestUrl)).toBe('https://opencode.ai/zen/v1/responses');
    const body = JSON.parse(String(requestInit.body));
    expect(body.input).toEqual([
      { role: 'system', content: 'system rule' },
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
    expect(body.max_output_tokens).toBe(10240);
    expect(body.max_tokens).toBeUndefined();
  });

  it('OpenRouter 使用 OpenAI 兼容接口和免费路由模型', async () => {
    mocks.readAllSettings.mockResolvedValueOnce({
      ai_provider: 'openrouter',
      openrouter_api_key: 'test-key',
      openrouter_base_url: 'https://openrouter.ai/api/v1',
      openrouter_model: 'openrouter/free',
      ai_temperature: '0.2',
      ai_max_tokens: '10240',
    });
    global.fetch = vi.fn().mockResolvedValueOnce(makeOkResponse('free response'));

    await expect(createChatCompletion([{ role: 'user', content: 'hi' }])).resolves.toMatchObject({
      content: 'free response',
      provider: 'openrouter',
      model: 'openrouter/free',
    });

    const [requestUrl, requestInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [RequestInfo, RequestInit];
    expect(String(requestUrl)).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(requestInit.headers).toBeInstanceOf(Headers);
    expect((requestInit.headers as Headers).get('authorization')).toBe('Bearer test-key');
  });

  it('OpenRouter 免费模型收到 429 时不重复发送重试请求', async () => {
    mocks.readAllSettings.mockResolvedValueOnce({
      ai_provider: 'openrouter',
      openrouter_api_key: 'test-key',
      openrouter_base_url: 'https://openrouter.ai/api/v1',
      openrouter_model: 'openrouter/free',
      ai_temperature: '0.2',
      ai_max_tokens: '10240',
    });
    global.fetch = vi.fn().mockResolvedValueOnce(new Response('rate limit', {
      status: 429,
      headers: { 'Retry-After': '60' },
    }));

    await expect(createChatCompletion([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      kind: 'rate_limit',
      status: 429,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('HTTP 成功但返回非 JSON 时按 Provider 全局故障处理', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(new Response('<html>gateway error</html>', { status: 200 }));

    await expect(createChatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow('API 返回无效 JSON');
  });

  it('HTTP 成功但响应为空时按 Provider 全局故障处理', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(makeOkResponse(''));

    await expect(createChatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow('API 返回空响应');
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

  it('OpenCode 免费模型收到 429 时不重复发送重试请求', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(new Response('rate limit', {
      status: 429,
      headers: { 'Retry-After': '60' },
    }));

    await expect(createChatCompletion([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      kind: 'rate_limit',
      status: 429,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('非免费 Provider 的 5xx 时重试并在仍失败后抛出服务端不可用', async () => {
    mocks.readAllSettings.mockResolvedValueOnce({
      ai_provider: 'deepseek',
      deepseek_api_key: 'test-key',
      deepseek_base_url: 'https://api.deepseek.com',
      deepseek_model: 'deepseek-v4-flash',
      ai_temperature: '0.2',
      ai_max_tokens: '10240',
    });
    global.fetch = vi.fn().mockImplementation(() => new Response('server error', { status: 503 }));

    // 立即挂上 rejection 处理器，避免 advanceTimers 期间产生 unhandled rejection
    const assertion = expect(createChatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow('服务暂不可用');
    // 跳过三次重试等待（初始 + 2 次重试）
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('Provider 恢复后下一次调用直接重新探测，不受进程内旧故障状态阻塞', async () => {
    mocks.readAllSettings.mockResolvedValueOnce({
      ai_provider: 'deepseek',
      deepseek_api_key: 'test-key',
      deepseek_base_url: 'https://api.deepseek.com',
      deepseek_model: 'deepseek-v4-flash',
      ai_temperature: '0.2',
      ai_max_tokens: '10240',
    });
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('server error', { status: 503 }))
      .mockResolvedValueOnce(new Response('server error', { status: 503 }))
      .mockResolvedValueOnce(new Response('server error', { status: 503 }))
      .mockResolvedValueOnce(makeOkResponse('recovered'));

    const failed = expect(createChatCompletion([{ role: 'user', content: 'first' }])).rejects.toThrow('服务暂不可用');
    await vi.advanceTimersByTimeAsync(30000);
    await failed;

    await expect(createChatCompletion([{ role: 'user', content: 'second' }])).resolves.toMatchObject({
      content: 'recovered',
    });
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it('网络错误时重试并最终失败', async () => {
    mocks.readAllSettings.mockResolvedValueOnce({
      ai_provider: 'deepseek',
      deepseek_api_key: 'test-key',
      deepseek_base_url: 'https://api.deepseek.com',
      deepseek_model: 'deepseek-v4-flash',
      ai_temperature: '0.2',
      ai_max_tokens: '10240',
    });
    global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

    const assertion = expect(createChatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow('无法连接 API 服务器');
    // 跳过三次重试等待（初始 + 2 次重试）
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('OpenCode 长正文请求使用 60 秒超时，且超时只影响当前文章', async () => {
    global.fetch = vi.fn().mockImplementation((_url, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));

    const assertion = expect(createChatCompletion([{ role: 'user', content: 'long article' }])).rejects.toMatchObject({
      kind: 'timeout',
      global: false,
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
  });

  it('DeepSeek 长正文请求使用 60 秒超时，且超时只影响当前文章', async () => {
    mocks.readAllSettings.mockResolvedValueOnce({
      ai_provider: 'deepseek',
      deepseek_api_key: 'test-key',
      deepseek_base_url: 'https://api.deepseek.com',
      deepseek_model: 'deepseek-v4-flash',
      ai_temperature: '0.2',
      ai_max_tokens: '10240',
    });
    global.fetch = vi.fn().mockImplementation((_url, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));

    const assertion = expect(createChatCompletion([{ role: 'user', content: 'long article' }])).rejects.toMatchObject({
      kind: 'timeout',
      global: false,
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
  });

  it('测试连接使用 15 秒交互超时且不自动重试', async () => {
    global.fetch = vi.fn().mockImplementation((_url, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));

    const assertion = expect(testAIConnection()).resolves.toMatchObject({
      success: false,
      error: '请求超时，请检查网络连接',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('OpenCode 网关不支持 response_format 时自动降级为客户端 JSON 校验', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('response_format is not supported', { status: 400 }))
      .mockResolvedValueOnce(makeOkResponse('{"ok":true}'));

    await expect(createChatCompletion([{ role: 'user', content: 'hi' }], { responseFormat: 'json_object' })).resolves.toMatchObject({
      content: '{"ok":true}',
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(secondBody.response_format).toBeUndefined();
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

  it('文章级 400 不标记为全局 Provider 故障，避免暂停后续文章', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('maximum context length exceeded', { status: 400 }));

    const error = await createChatCompletion([{ role: 'user', content: 'hi' }]).catch(value => value);

    expect(error).toBeInstanceOf(AIClientError);
    expect(error).toMatchObject({ kind: 'content', global: false, retryable: false, status: 400 });
  });
});
