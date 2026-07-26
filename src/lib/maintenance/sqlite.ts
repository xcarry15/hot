/**
 * SQLite 维护适配器。
 *
 * 只处理与 SQLite 文件/原始 SQL 相关的低层操作：
 *   - 获取数据库文件大小（用于 stats 与 vacuum 前后对比）
 *   - 执行 VACUUM，回收 DELETE 后未释放的磁盘空间
 *
 * 不涉及业务表、设置或 Job 编排；调用方应通过 `maintenance-service`
 * 统一协调清理动作。
 */
import fs from 'fs';
import path from 'path';
import { db } from '@/lib/db';

const DEFAULT_DATABASE_URL = 'file:../db/custom.db';

/**
 * 按 Prisma SQLite 的规则解析数据库文件路径。
 * 相对 file URL 是相对于 prisma/schema.prisma，而不是当前工作目录。
 */
export function getDbFilePath(): string | null {
  const databaseUrl = (process.env.DATABASE_URL || DEFAULT_DATABASE_URL).trim();
  if (!databaseUrl.startsWith('file:')) return null;

  try {
    const rawPath = decodeURIComponent(databaseUrl.slice('file:'.length).split('?')[0]);
    if (!rawPath) return null;
    if (process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(rawPath)) {
      return path.normalize(rawPath.slice(1));
    }
    if (path.isAbsolute(rawPath)) return path.normalize(rawPath);
    return path.resolve(process.cwd(), 'prisma', rawPath);
  } catch {
    return null;
  }
}

/** 获取数据库文件大小（字节），失败返回 0 */
export function getDbFileSize(): number {
  try {
    const dbPath = getDbFilePath();
    return dbPath ? fs.statSync(dbPath).size : 0;
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

/** 执行 VACUUM 并返回前后文件大小 */
export async function runVacuum(): Promise<VacuumResult> {
  const sizeBefore = getDbFileSize();
  // WAL 中的页面不会随 VACUUM 立即反映到主库文件，先截断 WAL，
  // 完成 VACUUM 后再执行一次，确保磁盘空间真正回收。
  await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
  await db.$executeRawUnsafe('VACUUM');
  await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
  const sizeAfter = getDbFileSize();
  return { vacuumed: true, sizeBefore, sizeAfter, saved: sizeBefore - sizeAfter };
}
