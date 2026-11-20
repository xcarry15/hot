import type { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { installSqliteWriteQueue } from '@/lib/sqlite-write-queue';

type TransactionCallback = (tx: Prisma.TransactionClient) => Promise<unknown>;

function callTransaction(
  client: PrismaClient,
  callback: TransactionCallback,
  options?: unknown,
): Promise<unknown> {
  const fn = client.$transaction as unknown as (
    first: TransactionCallback,
    second?: unknown,
  ) => Promise<unknown>;
  return fn(callback, options);
}

function createFakeClient() {
  const queryRawUnsafe = vi.fn(async () => undefined);
  const tx = { $queryRawUnsafe: queryRawUnsafe } as unknown as Prisma.TransactionClient;
  const state = { attempts: 0, active: 0, maxActive: 0 };
  const original = vi.fn(async (first: unknown) => {
    if (typeof first !== 'function') return ['array'];
    state.attempts++;
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await (first as TransactionCallback)(tx);
    } finally {
      state.active--;
    }
  });
  const client = { $transaction: original } as unknown as PrismaClient;
  return { client, original, state, queryRawUnsafe };
}

describe('sqlite-write-queue', () => {
  it('wrapped $transaction stays writable so tests can stub it', async () => {
    const { client } = createFakeClient();
    const wrapped = installSqliteWriteQueue(client);

    expect(Object.getOwnPropertyDescriptor(wrapped, '$transaction')?.writable).toBe(true);

    const target = wrapped as unknown as {
      $transaction: (...args: unknown[]) => Promise<unknown>;
    };
    const stub = vi.fn(async () => 'stubbed');
    target.$transaction = stub;

    await expect(target.$transaction(async () => 'ignored')).resolves.toBe('stubbed');
    expect(stub).toHaveBeenCalled();
  });

  it('serializes callback transactions and re-applies busy_timeout', async () => {
    const { client, state, queryRawUnsafe } = createFakeClient();
    const wrapped = installSqliteWriteQueue(client);

    const results = await Promise.all(
      [0, 1, 2].map((value) => callTransaction(wrapped, async () => value)),
    );

    expect(results).toEqual([0, 1, 2]);
    expect(state.maxActive).toBe(1);
    expect(queryRawUnsafe).toHaveBeenCalledTimes(3);
    expect(queryRawUnsafe).toHaveBeenCalledWith('PRAGMA busy_timeout=5000');
  });

  it('passes nested transactions through without deadlocking', async () => {
    const { client } = createFakeClient();
    const wrapped = installSqliteWriteQueue(client);

    const result = await callTransaction(
      wrapped,
      async () => callTransaction(wrapped, async () => 'inner'),
    );

    expect(result).toBe('inner');
  });

  it('does not queue array-style transactions', async () => {
    const { client, original, state } = createFakeClient();
    const wrapped = installSqliteWriteQueue(client);
    const arrayTransaction = wrapped.$transaction as unknown as (
      first: unknown,
    ) => Promise<unknown>;

    await expect(arrayTransaction([Promise.resolve('x')])).resolves.toEqual(['array']);
    expect(original).toHaveBeenCalled();
    expect(state.attempts).toBe(0);
  });

  it('retries transient SQLite conflicts and re-declares busy_timeout', async () => {
    const { client, state, queryRawUnsafe } = createFakeClient();
    const transient = new Error('database is locked') as Error & { code?: string };
    transient.code = 'P1008';
    queryRawUnsafe.mockRejectedValueOnce(transient);
    const wrapped = installSqliteWriteQueue(client);

    await expect(callTransaction(wrapped, async () => 'ok')).resolves.toBe('ok');
    expect(state.attempts).toBe(2);
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(queryRawUnsafe).toHaveBeenNthCalledWith(1, 'PRAGMA busy_timeout=5000');
    expect(queryRawUnsafe).toHaveBeenNthCalledWith(2, 'PRAGMA busy_timeout=5000');
  });
});
