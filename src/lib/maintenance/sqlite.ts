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
import { db } from '@/lib/db';

/** 获取数据库文件大小（字节），失败返回 0 */
export function getDbFileSize(): number {
  try {
    const dbPath = new URL(process.env.DATABASE_URL || 'file:../db/custom.db').pathname;
    // Windows path starts with /C:/ — strip leading /
    const fixed = process.platform === 'win32' ? dbPath.replace(/^\//, '') : dbPath;
    return fs.statSync(fixed).size;
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
  await db.$executeRawUnsafe('VACUUM');
  const sizeAfter = getDbFileSize();
  return { vacuumed: true, sizeBefore, sizeAfter, saved: sizeBefore - sizeAfter };
}
