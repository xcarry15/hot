import { PrismaClient } from '@prisma/client'
import { installSqliteWriteQueue } from '@/lib/sqlite-write-queue'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// 生产环境过去使用 `log: []`，DB 层零日志，慢查询/连接池/锁等待完全无痕迹，
// 排查 P0-1 时只能靠业务 console.error 反推。默认开启 warn/error；
// 需要慢查询明细时设置 PRISMA_QUERY_LOG=1（会打印全部 SQL，仅临时排障用）。
const logLevels = process.env.PRISMA_QUERY_LOG === '1'
  ? (['warn', 'error', 'query'] as const)
  : (['warn', 'error'] as const);

const client =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [...logLevels],
  })

// SQLite 单写者：把回调式交互式事务串行化，消除并发 P1008 / P2028。
// 幂等安装，HMR 下不会重复包装。
export const db = installSqliteWriteQueue(client)

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db