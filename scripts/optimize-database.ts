import { db } from '../src/lib/db'
import { initializeDatabaseRuntime } from '../src/lib/database-runtime'

async function main() {
  const status = await initializeDatabaseRuntime()
  console.log(`SQLite 已优化：journal_mode=${status.journalMode}, synchronous=${status.synchronous}, busy_timeout=${status.busyTimeout}`)
}

main()
  .catch((error) => {
    console.error('SQLite 优化失败', error)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
