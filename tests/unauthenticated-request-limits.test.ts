import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SMALL_JSON_BODY_BYTES } from '@/lib/request-body';
import { POST as adminAuthPost } from '@/app/api/admin-auth/route';
import { POST as sharePosterPost } from '@/app/api/public/share-poster/route';

function makeOversizedRequest(path: string, ip: string) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_SMALL_JSON_BODY_BYTES + 1).fill(32));
    },
    cancel,
  });
  const request = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'x-real-ip': ip },
    body,
    duplex: 'half',
  } as RequestInit);
  return { request, cancel };
}

describe('unauthenticated JSON request limits', () => {
  const originalApiToken = process.env.API_TOKEN;

  afterEach(() => {
    if (originalApiToken === undefined) delete process.env.API_TOKEN;
    else process.env.API_TOKEN = originalApiToken;
  });

  it('stops an oversized admin login body before parsing it', async () => {
    process.env.API_TOKEN = 'review-only-token';
    const { request, cancel } = makeOversizedRequest('/api/admin-auth', '192.0.2.10');

    const response = await adminAuthPost(request);

    expect(response.status).toBe(400);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('stops an oversized anonymous poster body before image rendering', async () => {
    const { request, cancel } = makeOversizedRequest('/api/public/share-poster', '192.0.2.11');

    const response = await sharePosterPost(request);

    expect(response.status).toBe(400);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
