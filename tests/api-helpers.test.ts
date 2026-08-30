import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError } from '@/lib/api-helpers';

describe('API error boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not echo internal exception details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = apiError(new Error('SQLITE path=/srv/db secret=token'), '操作失败');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '操作失败' });
  });

  it('keeps explicitly exposed business errors available to the UI', async () => {
    class PublicError extends Error {
      readonly exposeToClient = true;
      readonly status = 409;
      readonly code = 'article_revision_conflict';
    }

    const response = apiError(new PublicError('当前状态不允许此操作'), '操作失败');

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: '当前状态不允许此操作',
      code: 'article_revision_conflict',
    });
  });
});
