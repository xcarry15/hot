/**
 * 一次性清理:删除 Setting 表中已无代码引用的历史遗留键。
 *
 * 这些键来自一个已废弃的功能(单步 prompt + 品牌打分权重),当前 src/
 * 里 grep 不到任何引用,但 DB 留有物理行。导入/导出的 EXPORTABLE_SETTING_KEYS
 * 已不含它们(刻意排除),且 PUT 端点会拒绝写入,此处只负责物理清理。
 *
 * 幂等:可重复执行,已无目标键时打印 0 并退出。
 *
 * 用法:  npm run db:cleanup-legacy
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const LEGACY_KEYS = [
  'ai_step1_prompt',
  'ai_step2_prompt',
  'ai_weight_brand',
  'ai_block_brand_score',
  'ai_step1_summary_max_chars',
] as const;

export type LegacyKey = (typeof LEGACY_KEYS)[number];

export async function runCleanup(db: Prisma.TransactionClient | Pick<PrismaClient, 'setting'>): Promise<number> {
  const result = await db.setting.deleteMany({
    where: { key: { in: [...LEGACY_KEYS] } },
  });
  if (result.count > 0) {
    console.log(`[cleanup-legacy-settings] 已删除 ${result.count} 条历史遗留键:`);
    for (const k of LEGACY_KEYS) console.log(`  - ${k}`);
  } else {
    console.log('[cleanup-legacy-settings] 无遗留键,无需清理');
  }
  return result.count;
}

// 仅当本文件作为入口被执行时(而非被 import)才跑 main。
// 用 import.meta.url 而非 process.argv[1],避免 vitest/ts-node 等
// 不同运行器下 argv 形态差异导致误触发。
const isMain =
  typeof import.meta.url === 'string' &&
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const db = new PrismaClient();
  runCleanup(db)
    .catch((err) => {
      console.error('[cleanup-legacy-settings] 失败:', err);
      process.exit(1);
    })
    .finally(() => db.$disconnect());
}
