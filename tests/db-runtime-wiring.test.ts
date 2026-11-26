import { describe, expect, it, vi } from 'vitest';

vi.unmock('@/lib/db');

describe('db runtime wiring', () => {
  it('installs the write queue on the extended Prisma client', async () => {
    vi.stubEnv('DATABASE_URL', 'file:/tmp/hot-db-wiring-test.db');
    try {
      const { db } = await import('@/lib/db');
      const descriptor = Object.getOwnPropertyDescriptor(db, '$transaction');

      expect(descriptor).toBeDefined();
      expect(descriptor?.writable).toBe(true);
      expect(typeof db.$transaction).toBe('function');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
