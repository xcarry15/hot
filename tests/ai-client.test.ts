/**
 * ai-client.ts 功能测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  readAllSettings: vi.fn(),
  getAIProviderBackoff: vi.fn(),
  noteAIProviderFailure: vi.fn(),
  clearAIProviderBackoff: vi.fn(),
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
vi.mock('@/lib/ai-provider-backoff', () => ({
  getAIProviderBackoff: mocks.getAIProviderBackoff,
  noteAIProviderFailure: mocks.noteAIProviderFailure,
  clearAIProviderBackoff: mocks.clearAIProviderBackoff,
  AI_PROVIDER_RETRY_DELAY_MS: 2 * 60 * 1000,
  AI_RATE_LIMIT_RETRY_DELAY_MS: 5 * 60 * 1000,
}));

import { AIClientError, createChatCompletion, getAISettings, invalidateAISettingsCache, testAIConnection, testSavedAIModel } from '@/lib/ai-client';
import { OPENROUTER_FREE_REQUEST_INTERVAL_MS, resetAIRateGateForTests, waitForAIRequestSlot } from '@/lib/ai-rate-gate';

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
    mocks.getAIProviderBackoff.mockResolvedValue(null);
    mocks.noteAIProviderFailure.mockResolvedValue({ cooldownUntil: null });
    mocks.clearAIProviderBackoff.mockResolvedValue(undefined);
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
    expect(mocks.noteAIProviderFailure).toHaveBeenCalledWith('opencode', {
      kind: 'provider',
      status: 200,
    });
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

  it('OpenRouter 付费模型配置回退到免费路由，避免意外扣费', async () => {
    mocks.readAllSettings.mockResolvedValueOnce({
      ai_provider: 'openrouter',
      openrouter_api_key: 'test-key',
      openrouter_base_url: 'https://openrouter.ai/api/v1',
      openrouter_model: 'vendor/paid-model',
    });

    await expect(getAISettings()).resolves.toMatchObject({
      provider: 'openrouter',
      model: 'openrouter/free',
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
    expect(mocks.noteAIProviderFailure).toHaveBeenCalledWith('deepseek', { kind: 'network' });
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

  it('切换 Provider 测试时只回退到目标 Provider 的已保存密钥', async () => {
    mocks.readAllSettings.mockResolvedValue({
      ai_provider: 'opencode',
      opencode_api_key: 'opencode-key',
      opencode_base_url: 'https://opencode.ai/zen/v1',
      opencode_model: 'big-pickle',
      openrouter_api_key: 'openrouter-key',
      openrouter_base_url: 'https://openrouter.ai/api/v1',
      openrouter_model: 'openrouter/free',
    });
    global.fetch = vi.fn().mockResolvedValueOnce(makeOkResponse('ok'));

    await expect(testAIConnection({
      provider: 'openrouter',
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openrouter/free',
    })).resolves.toMatchObject({ success: true, provider: 'openrouter' });

    const requestInit = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((requestInit.headers as Headers).get('authorization')).toBe('Bearer openrouter-key');
  });

  it('缺少 API Key 时直接返回配置错误，不发送无效请求', async () => {
    mocks.readAllSettings.mockResolvedValueOnce({
      ai_provider: 'opencode',
      opencode_api_key: '',
      opencode_base_url: 'https://opencode.ai/zen/v1',
      opencode_model: 'big-pickle',
    });
    global.fetch = vi.fn();

    await expect(testAIConnection()).resolves.toMatchObject({
      success: false,
      errorKind: 'configuration',
      error: '未填写 API Key',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('健康测试耗时不包含免费请求闸门的排队等待', async () => {
    mocks.readAllSettings.mockResolvedValue({
      ai_provider: 'openrouter',
      openrouter_api_key: 'test-openrouter-key',
      openrouter_base_url: 'https://openrouter.ai/api/v1',
      openrouter_model: 'openrouter/free',
      ai_temperature: '0.2',
      ai_max_tokens: '10240',
    });
    global.fetch = vi.fn().mockResolvedValueOnce(makeOkResponse('ok'));

    await waitForAIRequestSlot('openrouter', 'openrouter/free');
    const pending = testSavedAIModel('openrouter', 'minimax/minimax-m3:free');
    await vi.advanceTimersByTimeAsync(OPENROUTER_FREE_REQUEST_INTERVAL_MS);
    const result = await pending;

    expect(result.success).toBe(true);
    expect(result.latencyMs).toBe(0);
  });

  it('免费模型健康测试读取指定 Provider 的已保存配置并返回耗时', async () => {
    mocks.readAllSettings.mockResolvedValue({
      ai_provider: 'openrouter',
      openrouter_api_key: 'test-openrouter-key',
      openrouter_base_url: 'https://openrouter.ai/api/v1',
      openrouter_model: 'openrouter/free',
      ai_temperature: '0.2',
      ai_max_tokens: '10240',
    });
    global.fetch = vi.fn().mockResolvedValueOnce(makeOkResponse('ok'));

    await expect(testSavedAIModel('openrouter', 'minimax/minimax-m3:free')).resolves.toMatchObject({
      success: true,
      provider: 'openrouter',
      model: 'minimax/minimax-m3:free',
      latencyMs: expect.any(Number),
    });
    const [requestUrl, requestInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [RequestInfo, RequestInit];
    expect(String(requestUrl)).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((requestInit.headers as Headers).get('authorization')).toBe('Bearer test-openrouter-key');
    expect(JSON.parse(String(requestInit.body)).max_tokens).toBe(16);
  });

  it('候选模型 5xx 不写入生产 Provider 持久化冷却', async () => {
    mocks.readAllSettings.mockResolvedValue({
      ai_provider: 'openrouter',
      openrouter_api_key: 'test-openrouter-key',
      openrouter_base_url: 'https://openrouter.ai/api/v1',
      openrouter_model: 'openrouter/free',
    });
    global.fetch = vi.fn().mockResolvedValueOnce(new Response('model unavailable', { status: 503 }));

    await expect(testSavedAIModel('openrouter', 'minimax/minimax-m3:free')).resolves.toMatchObject({
      success: false,
      errorKind: 'provider',
      status: 503,
    });
    expect(mocks.noteAIProviderFailure).not.toHaveBeenCalled();
  });

  it('免费模型健康测试拒绝非免费模型且不发送请求', async () => {
    global.fetch = vi.fn();

    await expect(testSavedAIModel('openrouter', 'paid-model')).resolves.toMatchObject({
      success: false,
      error: '仅允许测试免费模型',
      errorKind: 'configuration',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('免费模型健康测试遇到已有冷却时立即返回，不重复等待或发请求', async () => {
    mocks.readAllSettings.mockResolvedValue({
      ai_provider: 'openrouter',
      openrouter_api_key: 'test-openrouter-key',
      openrouter_base_url: 'https://openrouter.ai/api/v1',
      openrouter_model: 'openrouter/free',
      ai_temperature: '0.2',
      ai_max_tokens: '10240',
    });
    global.fetch = vi.fn().mockResolvedValueOnce(new Response('rate limit', { status: 429 }));

    await expect(testSavedAIModel('openrouter', 'minimax/minimax-m3:free')).resolves.toMatchObject({
      success: false,
      errorKind: 'rate_limit',
      status: 429,
    });

    (global.fetch as ReturnType<typeof vi.fn>).mockClear();
    await expect(testSavedAIModel('openrouter', 'openrouter/free')).resolves.toMatchObject({
      success: false,
      errorKind: 'rate_limit',
      status: 429,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('结构化请求不发送 response_format，且只发起一次模型请求', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(makeOkResponse('{"ok":true}'));

    await expect(createChatCompletion([{ role: 'user', content: 'hi' }], { responseFormat: 'json_object' })).resolves.toMatchObject({
      content: '{"ok":true}',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const requestInit = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(body.response_format).toBeUndefined();
  });

  it('持久化 Provider 冷却期间快速失败，不再次触发上游请求', async () => {
    mocks.readAllSettings.mockResolvedValueOnce({
      ai_provider: 'deepseek',
      deepseek_api_key: 'test-key',
      deepseek_base_url: 'https://api.deepseek.com',
      deepseek_model: 'deepseek-v4-flash',
      ai_temperature: '0.2',
      ai_max_tokens: '10240',
    });
    const cooldownUntil = new Date(Date.now() + 120_000);
    mocks.getAIProviderBackoff.mockResolvedValueOnce({
      cooldownUntil,
      lastErrorKind: 'provider',
      lastStatus: 503,
    });
    global.fetch = vi.fn();

    await expect(createChatCompletion([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      kind: 'provider',
      status: 503,
      retryAfterMs: expect.any(Number),
    });
    expect(global.fetch).not.toHaveBeenCalled();
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
