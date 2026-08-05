import { describe, expect, it } from 'vitest';
import { evaluateFeishuResponse } from '@/lib/push/feishu-transport';

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
