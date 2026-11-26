import { PrismaClient } from '@prisma/client'
import {
  installSqliteWriteQueue,
  shouldRetryPrismaAction,
  withTransientSqliteRetry,
} from '@/lib/sqlite-write-queue'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  rawPrisma: PrismaClient | undefined
}

// 生产环境过去使用 `log: []`，DB 层零日志，慢查询/连接池/锁等待完全无痕迹，
// 排查 P0-1 时只能靠业务 console.error 反推。默认开启 warn/error；
// 需要慢查询明细时设置 PRISMA_QUERY_LOG=1（会打印全部 SQL，仅临时排障用）。
const logLevels = process.env.PRISMA_QUERY_LOG === '1'
  ? (['warn', 'error', 'query'] as const)
  : (['warn', 'error'] as const);

// rawPrisma 单独缓存：$extends 每次调用都会产生新客户端，
// HMR 下若把扩展后的实例当作下一次的基座，会层层嵌套重试扩展。
const client =
  globalForPrisma.rawPrisma ??
  new PrismaClient({
    log: [...logLevels],
  })

// 线上大量 P1008 来自未走事务队列的独立语句（update / upsert / count /
// updateMany 等）。用 Prisma query extension 统一做瞬态重试，覆盖所有模型；
// create、裸 SQL、原子自增由 shouldRetryPrismaAction 排除，避免重复写入。
const retryingClient = client.$extends({
  query: {
    $allModels: {
      async $allOperations({ operation, args, query }) {
        if (!shouldRetryPrismaAction(operation, args)) return query(args)
        return withTransientSqliteRetry(() => query(args), { maxRetries: 3, baseDelayMs: 250 })
      },
    },
  },
})

// SQLite 单写者：把回调式交互式事务串行化，消除并发 P1008 / P2028。
// 幂等安装，HMR 下不会重复包装。
export const db = installSqliteWriteQueue(retryingClient as unknown as PrismaClient)

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.rawPrisma = client
  globalForPrisma.prisma = db
}
