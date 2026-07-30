import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSafe,
  fetchHtml,
  MAX_HTTP_RESPONSE_BYTES,
  ensureResponseTextWithinLimit,
  isLikelyJavaScriptVerificationPage,
  readResponseText,
} from '@/lib/http';
import { assertSafeOutboundUrl, isBlockedOutboundHostname } from '@/lib/outbound-url';

describe('outbound URL boundary', () => {
  it.each([
    'localhost',
    'api.localhost',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fc00::1',
  ])('blocks private or local hostname %s', (hostname) => {
    expect(isBlockedOutboundHostname(hostname)).toBe(true);
  });

  it('allows a public hostname in test mode without performing real DNS', async () => {
    await expect(assertSafeOutboundUrl('https://example.com/path')).resolves.toMatchObject({
      hostname: 'example.com',
      protocol: 'https:',
    });
  });

  it('rejects private literal URLs before any fetch', async () => {
    await expect(assertSafeOutboundUrl('http://127.0.0.1:3011/internal')).rejects.toThrow('受限主机');
    await expect(assertSafeOutboundUrl('ftp://example.com/file')).rejects.toThrow('仅允许 http/https');
  });
});

describe('bounded response reader', () => {
  it('rejects a declared or streamed body over the configured limit', async () => {
    const response = new Response('1234', { headers: { 'content-length': '4' } });
    await expect(readResponseText(response, 3)).rejects.toThrow('响应体超过 3 字节限制');
    expect(() => ensureResponseTextWithinLimit('1234', 3)).toThrow('响应体超过 3 字节限制');
  });

  it('keeps the default response ceiling finite', () => {
    expect(MAX_HTTP_RESPONSE_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe('safe redirect cookies', () => {
  afterEach(() => {
    vi.mocked(global.fetch).mockReset();
  });

  it('carries a Set-Cookie value through a same-host redirect only for this request', async () => {
    const requests: Array<{ url: string; cookie: string | null }> = [];
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      requests.push({ url: String(input), cookie: new Headers(init?.headers).get('cookie') });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://example.com/information/',
            'set-cookie': 'challenge=passed; Path=/; HttpOnly',
          },
        });
      }
      return new Response('<html>ok</html>', { status: 200 });
    });

    await expect(fetchSafe('https://example.com/information/')).resolves.toMatchObject({ status: 200 });
    expect(requests).toEqual([
      { url: 'https://example.com/information/', cookie: null },
      { url: 'https://example.com/information/', cookie: 'challenge=passed' },
    ]);
  });

  it('does not forward a redirect cookie to a different host', async () => {
    const requests: Array<{ url: string; cookie: string | null }> = [];
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      requests.push({ url: String(input), cookie: new Headers(init?.headers).get('cookie') });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://other.example.com/information/',
            'set-cookie': 'challenge=passed; Path=/; HttpOnly',
          },
        });
      }
      return new Response('<html>ok</html>', { status: 200 });
    });

    await fetchSafe('https://example.com/information/');
    expect(requests[1]).toEqual({ url: 'https://other.example.com/information/', cookie: null });
  });
});

describe('JavaScript verification page detection', () => {
  it('does not treat a cookie-and-reload verification shell as a usable page', () => {
    expect(isLikelyJavaScriptVerificationPage(
      '<script>window.open("/news/1", "_self"); document.cookie="challenge=passed; path=/";</script>',
    )).toBe(true);
    expect(isLikelyJavaScriptVerificationPage('<html><body>正常文章正文</body></html>')).toBe(false);
  });

  it('replays a same-host verification cookie with redirect cookies for one fetchHtml call', async () => {
    const requests: Array<{ url: string; cookie: string | null }> = [];
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      requests.push({ url: String(input), cookie: new Headers(init?.headers).get('cookie') });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://example.com/article/1',
            'set-cookie': 'redirect=passed; Path=/; HttpOnly',
          },
        });
      }
      if (requests.length === 2) {
        return new Response(
          '<script>window.open("/article/1", "_self"); document.cookie="verify=passed; path=/";</script>',
          { status: 200 },
        );
      }
      return new Response('<html><body>article</body></html>', { status: 200 });
    });

    await expect(fetchHtml('https://example.com/article/1')).resolves.toContain('article');
    expect(requests).toEqual([
      { url: 'https://example.com/article/1', cookie: null },
      { url: 'https://example.com/article/1', cookie: 'redirect=passed' },
      { url: 'https://example.com/article/1', cookie: 'redirect=passed; verify=passed' },
    ]);
  });
});
