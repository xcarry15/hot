import { describe, expect, it } from 'vitest';
import { MAX_HTTP_RESPONSE_BYTES, ensureResponseTextWithinLimit, readResponseText } from '@/lib/http';
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
