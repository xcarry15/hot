import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.unmock('@/lib/db');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-write-queue-'));
const dbUrl = `file:${path.join(tempDir, 'test.db').replace(/\\/g, '/')}`;

describe('write queue on a real extended Prisma client', () => {
  beforeAll(() => {
    vi.stubEnv('DATABASE_URL', dbUrl);
    execFileSync(
      process.execPath,
      [path.join(process.cwd(), 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe', timeout: 60_000 },
    );
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('serializes callback transactions and keeps the extension usable inside tx', async () => {
    const { db } = await import('@/lib/db');
    const { getWriteQueueStats } = await import('@/lib/sqlite-write-queue');
    const before = getWriteQueueStats().serialized;
    let active = 0;
    let maxActive = 0;

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        (db.$transaction as unknown as (fn: (tx: typeof db) => Promise<number>) => Promise<number>)(
          async (tx) => {
            active++;
            maxActive = Math.max(maxActive, active);
            try {
              await new Promise((resolve) => setTimeout(resolve, 20));
              return await tx.article.count();
            } finally {
              active--;
            }
          },
        ).then(() => index),
      ),
    );

    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(maxActive).toBe(1);
    expect(getWriteQueueStats().serialized - before).toBe(5);
  });
});
