import { db } from '@/lib/db'

export interface DatabaseRuntimeStatus {
  journalMode: string
  synchronous: number
  busyTimeout: number
}

export async function initializeDatabaseRuntime(): Promise<DatabaseRuntimeStatus> {
  // journal_mode 持久化在 SQLite 文件中；其余参数按当前连接设置。
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
