/**
 * SQLite 维护适配器。
 *
 * 只处理原始 SQLite 命令：
 *   - 用 page_count × page_size 获取当前数据库占用
 *   - 执行 VACUUM，回收 DELETE 后未释放的页面
 *
 * 不读取数据库文件路径。路径由运行时 DATABASE_URL 决定，直接走文件系统既可能
 * 在部署目录中取错，也会使打包器把动态路径误追踪为整个项目。
 */
import { db } from '@/lib/db';

type PragmaRow = Record<string, unknown>;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
  return null;
}

async function readPragmaNumber(name: 'page_count' | 'page_size'): Promise<number | null> {
  const rows = await db.$queryRawUnsafe<PragmaRow[]>(`PRAGMA ${name}`);
  return toFiniteNumber(rows[0]?.[name]);
}

/** 获取 SQLite 当前主库页占用（字节）；失败返回 0。 */
export async function getDbFileSize(): Promise<number> {
  try {
    const [pageCount, pageSize] = await Promise.all([
      readPragmaNumber('page_count'),
      readPragmaNumber('page_size'),
    ]);
    if (pageCount === null || pageSize === null) return 0;
    const size = pageCount * pageSize;
    return Number.isSafeInteger(size) && size >= 0 ? size : 0;
  } catch {
    return 0;
  }
}

export interface VacuumResult {
  vacuumed: true;
  sizeBefore: number;
  sizeAfter: number;
  saved: number;
}

/** 执行 VACUUM 并返回前后 SQLite 页占用。 */
export async function runVacuum(): Promise<VacuumResult> {
  const sizeBefore = await getDbFileSize();
  // WAL 中的页面不会随 VACUUM 立即反映到主库，先截断 WAL，
  // 完成 VACUUM 后再执行一次，确保空间回收可被页统计反映。
  await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
  await db.$executeRawUnsafe('VACUUM');
  await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
  const sizeAfter = await getDbFileSize();
  return { vacuumed: true, sizeBefore, sizeAfter, saved: Math.max(0, sizeBefore - sizeAfter) };
}
