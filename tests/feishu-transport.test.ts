import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateFeishuResponse, sendFeishuWebhook } from '@/lib/push/feishu-transport';
import { fetchSafe, readResponseText } from '@/lib/http';

vi.mock('@/lib/http', () => ({ fetchSafe: vi.fn(), readResponseText: vi.fn() }));

describe('Feishu webhook business response', () => {
  it('HTTP 2xx 且 code=0 才算成功', () => {
    expect(evaluateFeishuResponse(200, JSON.stringify({ code: 0, msg: 'success' }))).toEqual({ ok: true });
    expect(evaluateFeishuResponse(200, JSON.stringify({ StatusCode: 0, StatusMessage: 'success' }))).toEqual({ ok: true });
  });

  it('HTTP 2xx 的业务错误不能被记为成功', () => {
    const result = evaluateFeishuResponse(200, JSON.stringify({ code: 19001, msg: 'invalid token' }));
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('code=19001');
    expect(result.errorMessage).toContain('invalid token');
    expect(evaluateFeishuResponse(200, JSON.stringify({ code: '' })).ok).toBe(false);
  });

  it('空响应或非 JSON 响应按失败处理', () => {
    expect(evaluateFeishuResponse(204, '').ok).toBe(false);
    expect(evaluateFeishuResponse(200, '<html>ok</html>').ok).toBe(false);
  });
});

describe('Feishu 投递不确定性', () => {
  const config = { url: 'https://example.com/hook', remark: '测试', enabled: true };
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('远端可能已接收但连接断开时，只发送一次并返回 unknown', async () => {
    vi.mocked(fetchSafe).mockRejectedValue(new Error('socket closed after POST'));
    const result = sendFeishuWebhook(config, {});
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ ok: false, unknown: true, retryCount: 0 });
    expect(fetchSafe).toHaveBeenCalledTimes(1);
  });

  it('HTTP 200 响应体读取失败时不补发', async () => {
    vi.mocked(fetchSafe).mockResolvedValue(new Response(null, { status: 200 }));
    vi.mocked(readResponseText).mockRejectedValue(new Error('response lost'));
    const result = sendFeishuWebhook(config, {});
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ ok: false, unknown: true });
    expect(fetchSafe).toHaveBeenCalledTimes(1);
  });

  it.each([['', 200], ['{}', 200], ['<html>gateway</html>', 200], ['error', 502]] as const)(
    '无法确认业务结果 %s / HTTP %i 时保留 unknown', async (body, status) => {
      vi.mocked(fetchSafe).mockResolvedValue(new Response(null, { status }));
      vi.mocked(readResponseText).mockResolvedValue(body);
      const result = sendFeishuWebhook(config, {});
      await vi.runAllTimersAsync();
      await expect(result).resolves.toMatchObject({ ok: false, unknown: true });
      expect(fetchSafe).toHaveBeenCalledTimes(1);
    },
  );

  it('明确业务拒绝不会在本次投递中重复请求', async () => {
    vi.mocked(fetchSafe).mockResolvedValue(new Response(null, { status: 200 }));
    vi.mocked(readResponseText).mockResolvedValue('{"code":19001,"msg":"invalid token"}');
    const result = sendFeishuWebhook(config, {});
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ ok: false });
    expect((await result).unknown).not.toBe(true);
    expect(fetchSafe).toHaveBeenCalledTimes(1);
  });

  it('明确 HTTP 429 拒绝仍有有限重试', async () => {
    vi.mocked(fetchSafe)
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.mocked(readResponseText).mockResolvedValueOnce('rate limited').mockResolvedValueOnce('{"code":0}');
    const result = sendFeishuWebhook(config, {});
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ ok: true, retryCount: 1 });
    expect(fetchSafe).toHaveBeenCalledTimes(2);
  });
});
