import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  installSqliteWriteQueue,
  shouldRetryPrismaAction,
  withTransientSqliteRetry,
} from '@/lib/sqlite-write-queue';

function transientError(): Error & { code: string } {
  return Object.assign(
    new Error('Socket timeout (the database failed to respond to a query within the configured timeout).'),
    { code: 'P1008' },
  );
}

describe('withTransientSqliteRetry', () => {
  it('retries transient errors and returns the successful result', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(transientError())
      .mockResolvedValueOnce('ok');

    await expect(withTransientSqliteRetry(operation, { baseDelayMs: 1 })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient errors', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('validation failed'));

    await expect(withTransientSqliteRetry(operation, { baseDelayMs: 1 })).rejects.toThrow('validation failed');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('throws the last transient error after retries are exhausted', async () => {
    const operation = vi.fn().mockRejectedValue(transientError());

    await expect(
      withTransientSqliteRetry(operation, { maxRetries: 2, baseDelayMs: 1 }),
    ).rejects.toMatchObject({ code: 'P1008' });
    expect(operation).toHaveBeenCalledTimes(3);
  });
});

describe('shouldRetryPrismaAction', () => {
  it('skips non-idempotent writes and raw SQL', () => {
    for (const action of ['create', 'createMany', 'createManyAndReturn', 'delete', '$executeRaw', '$executeRawUnsafe']) {
      expect(shouldRetryPrismaAction(action)).toBe(false);
    }
  });

  it('allows idempotent reads and writes outside transactions', () => {
    for (const action of ['findMany', 'count', 'update', 'updateMany', 'upsert', 'deleteMany']) {
      expect(shouldRetryPrismaAction(action)).toBe(true);
    }
  });

  it('skips writes with atomic increments to avoid double counting', () => {
    expect(shouldRetryPrismaAction('update', { data: { attempt: { increment: 1 } } })).toBe(false);
    expect(shouldRetryPrismaAction('updateMany', { data: { count: { decrement: 1 } } })).toBe(false);
    expect(shouldRetryPrismaAction('upsert', {
      where: { id: 'x' },
      update: { hits: { increment: 1 } },
      create: { hits: 1 },
    })).toBe(false);
    expect(shouldRetryPrismaAction('upsert', {
      where: { id: 'x' },
      update: { hits: 2 },
      create: { hits: { increment: 1 } },
    })).toBe(false);
    expect(shouldRetryPrismaAction('update', { data: { status: 'running' } })).toBe(true);
  });

  it('allows upsert retry only when create and update payloads are equivalent', () => {
    expect(shouldRetryPrismaAction('upsert', {
      where: { phrase: 'x' },
      create: { occurrences: 1, status: 'pending' },
      update: { occurrences: 1, status: 'pending' },
    })).toBe(true);
    expect(shouldRetryPrismaAction('upsert', {
      where: { phrase: 'x' },
      create: { occurrences: 1, status: 'new' },
      update: { occurrences: 1, status: 'seen' },
    })).toBe(false);
  });

  it('skips writes with nested create/connect to avoid duplicate child rows', () => {
    expect(shouldRetryPrismaAction('update', {
      where: { id: 'x' },
      data: { logs: { create: { text: 'x' } } },
    })).toBe(false);
    expect(shouldRetryPrismaAction('update', {
      where: { id: 'x' },
      data: { event: { connectOrCreate: { where: { id: 'e' }, create: { id: 'e' } } } },
    })).toBe(false);
    expect(shouldRetryPrismaAction('update', {
      where: { id: 'x' },
      data: { title: 'new' },
    })).toBe(true);
  });

  it('skips retries inside queued transactions to avoid double retry', async () => {
    const tx = { $queryRawUnsafe: vi.fn(async () => undefined) };
    const client = {
      $transaction: vi.fn(async (first: (client: unknown) => Promise<unknown>) => first(tx)),
    } as unknown as PrismaClient;
    const wrapped = installSqliteWriteQueue(client);
    const run = wrapped.$transaction as unknown as (fn: () => Promise<boolean>) => Promise<boolean>;

    const inside = await run(async () => shouldRetryPrismaAction('update'));

    expect(inside).toBe(false);
    expect(shouldRetryPrismaAction('update')).toBe(true);
  });
});
