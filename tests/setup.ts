/**
 * Vitest 全局设置
 *
 * - mock prisma client：测试不连真实 DB
 * - mock Next.js Request/Response
 * - 屏蔽 console.error 噪音（可按需开启）
 */

import { vi } from 'vitest';

// Mock prisma
vi.mock('@/lib/db', () => ({
  db: {
    article: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
      groupBy: vi.fn(),
    },
    source: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    setting: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    keyword: {
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
    pushLog: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    fetchLog: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    discardedItem: {
      findMany: vi.fn(),
    },
    job: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

// Mock global fetch
global.fetch = vi.fn(async () => {
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as unknown as typeof fetch;
