import { db } from '@/lib/db'

export interface DatabaseRuntimeStatus {
  journalMode: string
  synchronous: number
  busyTimeout: number
}

export async function initializeDatabaseRuntime(): Promise<DatabaseRuntimeStatus> {
  // 作用域说明（2026-11-20 审查 P0-2 实测）：
  //   - journal_mode=WAL 是**库级**、持久化在 SQLite 文件中，对所有连接生效。
  //   - synchronous / busy_timeout / foreign_keys 是**连接级**，只作用于执行
  //     它的这一条连接。实测 Prisma 默认已把 busy_timeout=5000 与
  //     foreign_keys=ON 应用到池中每条连接；其余连接 synchronous 为 FULL(2)，
  //     比 NORMAL(1) 更安全；foreign_keys 在事务内设置是 no-op。
  // 因此这里不再声称「整库已配置」；回调式写事务由 sqlite-write-queue 在各自
  // 绑定的连接上重新声明 busy_timeout，避免依赖初始化连接。
  const journalRows = await db.$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode=WAL')
  await db.$queryRawUnsafe('PRAGMA synchronous=NORMAL')
  await db.$queryRawUnsafe('PRAGMA busy_timeout=5000')
  await db.$queryRawUnsafe('PRAGMA foreign_keys=ON')
  await db.$queryRawUnsafe('PRAGMA optimize')

  const synchronousRows = await db.$queryRawUnsafe<Array<{ synchronous: number }>>('PRAGMA synchronous')
  const busyTimeoutRows = await db.$queryRawUnsafe<Array<{ timeout: number }>>('PRAGMA busy_timeout')
  return {
    journalMode: journalRows[0]?.journal_mode ?? 'unknown',
    synchronous: Number(synchronousRows[0]?.synchronous ?? -1),
    busyTimeout: Number(busyTimeoutRows[0]?.timeout ?? -1),
  }
}
