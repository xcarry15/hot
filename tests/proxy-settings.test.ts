import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchSafe: vi.fn(),
  readResponseText: vi.fn(),
}));

vi.mock('@/lib/http', () => ({
  fetchSafe: mocks.fetchSafe,
  readResponseText: mocks.readResponseText,
}));

import { invalidateFreeProxyCache, testOutboundProxies, testOutboundProxy } from '@/lib/proxy-test-service';

afterEach(() => {
  invalidateFreeProxyCache();
  vi.resetAllMocks();
});

describe('全局代理连通性测试', () => {
  it('拒绝空代理地址，不发起外部请求', async () => {
    await expect(testOutboundProxy('')).resolves.toMatchObject({
      success: false,
      error: '请先填写代理地址',
    });
    expect(mocks.fetchSafe).not.toHaveBeenCalled();
  });

  it('使用输入代理访问赢商网公开页面', async () => {
    mocks.fetchSafe.mockResolvedValue(new Response('<html>winshang</html>', { status: 200 }));
    mocks.readResponseText.mockResolvedValue('<html>winshang</html>');

    await expect(testOutboundProxy('http://proxy.example:8080')).resolves.toMatchObject({
      success: true,
      status: 200,
    });
    expect(mocks.fetchSafe).toHaveBeenCalledWith(
      'https://news.winshang.com/list-12.html',
      expect.objectContaining({ proxyUrl: 'http://proxy.example:8080' }),
    );
  });

  it('把目标页面的 403 作为代理不可用返回', async () => {
    mocks.fetchSafe.mockResolvedValue(new Response('forbidden', { status: 403 }));
    mocks.readResponseText.mockResolvedValue('forbidden');

    await expect(testOutboundProxy('http://proxy.example:8080')).resolves.toMatchObject({
      success: false,
      status: 403,
      error: '目标页面返回 HTTP 403',
    });
  });

  it('批量测试所有免费节点并选出最快节点', async () => {
    const bodies = new WeakMap<Response, string>();
    mocks.fetchSafe.mockImplementation(async (url: string, options: { proxyUrl?: string; bypassProxy?: boolean }) => {
      if (options.bypassProxy) {
        const body = url.includes('relayglass')
          ? '120.232.115.170:17981\n120.232.115.171:17981'
          : url.includes('proxifly')
            ? '122.246.3.12:17981\n122.246.3.13:17981'
            : '116.196.150.180:17981\n116.196.150.181:17981';
        const response = new Response(null, { status: 200 });
        bodies.set(response, body);
        return response;
      }
      const delay = options.proxyUrl?.includes('120.232.115.170') ? 5 : 20;
      await new Promise((resolve) => setTimeout(resolve, delay));
      const response = new Response(null, { status: 200 });
      bodies.set(response, '<html>winshang</html>');
      return response;
    });
    mocks.readResponseText.mockImplementation(async (response: Response) => bodies.get(response) || '');

    const result = await testOutboundProxies();

    expect(result.results).toHaveLength(6);
    expect(result.results.every((item) => item.success)).toBe(true);
    expect(result.sourceCount).toBe(3);
    expect(result.fastestUrl).toBe('http://120.232.115.170:17981');
  });
});
