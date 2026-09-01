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
        const body = url.includes('hproxy')
          ? '203.0.113.10:17981\n203.0.113.11:17981'
          : '198.51.100.10:17981\n198.51.100.11:17981';
        const response = new Response(null, { status: 200 });
        bodies.set(response, body);
        return response;
      }
      const delay = options.proxyUrl?.includes('203.0.113.10') ? 5 : 20;
      await new Promise((resolve) => setTimeout(resolve, delay));
      const response = new Response(null, { status: 200 });
      bodies.set(response, '<html>winshang</html>');
      return response;
    });
    mocks.readResponseText.mockImplementation(async (response: Response) => bodies.get(response) || '');

    const result = await testOutboundProxies();

    expect(result.results).toHaveLength(22);
    expect(result.results.every((item) => item.success)).toBe(true);
    expect(result.sourceCount).toBe(2);
    expect(result.results.slice(0, 6).map((item) => item.label)).toEqual([
      '历史可用节点 #1',
      '历史可用节点 #2',
      '历史可用节点 #3',
      '历史可用节点 #4',
      '历史可用节点 #5',
      '历史可用节点 #6',
    ]);
    expect(result.results.slice(6, 18).map((item) => item.label)).toEqual([
      '近期验证节点 #1',
      '近期验证节点 #2',
      '近期验证节点 #3',
      '近期验证节点 #4',
      '近期验证节点 #5',
      '近期验证节点 #6',
      '近期验证节点 #7',
      '近期验证节点 #8',
      '近期验证节点 #9',
      '近期验证节点 #10',
      '近期验证节点 #11',
      '近期验证节点 #12',
    ]);
    expect(result.fastestUrl).toBe('http://203.0.113.10:17981');
  });

  it('动态列表全部失败时仍保留历史和近期验证节点', async () => {
    mocks.fetchSafe.mockImplementation(async (_url: string, options: { bypassProxy?: boolean }) => {
      if (options.bypassProxy) throw new Error('列表源不可达');
      return new Response('<html>winshang</html>', { status: 200 });
    });
    mocks.readResponseText.mockResolvedValue('<html>winshang</html>');

    const result = await testOutboundProxies();

    expect(result.results).toHaveLength(18);
    expect(result.results.map((item) => item.url)).toEqual([
      'http://112.64.135.45:8080',
      'http://116.196.150.180:17981',
      'http://120.232.115.170:17981',
      'http://122.246.3.12:17981',
      'http://122.246.4.6:17981',
      'http://58.254.153.146:17981',
      'http://27.185.218.213:17981',
      'http://114.236.137.41:21000',
      'http://101.132.170.8:7890',
      'http://39.106.170.168:8080',
      'http://39.106.165.196:8080',
      'http://47.121.139.13:3128',
      'http://123.121.131.112:8888',
      'http://123.121.113.161:8888',
      'http://114.248.179.223:8888',
      'http://123.121.132.32:8888',
      'http://123.112.220.78:8888',
      'http://221.221.163.25:8888',
    ]);
    expect(result.sourceErrors).toHaveLength(2);
    expect(result.sourceErrors[0]).toContain('列表源不可达');
  });
});
