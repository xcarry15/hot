/**
 * 一次性回填:DB 中 ai_block_* 和 ai_system_prompt 为空串的行,用 prompts.ts
 * 里的默认值回填。
 *
 * 原因:历史 buildSavePayload 把「等于默认值」的提示词抹成空串,导致 DB 存
 * 的是空串,UI 通过 `value || defaultBlock` 显示默认文本。导入/导出场景
 * 下空串会原样导出,看起来"提示词没了"。
 * 修正后:DB 存实际文本,UI 行为不变(依然 `|| defaultBlock` 兜底),
 * 导出会带完整内容。
 *
 * 幂等:可重复执行,已回填的行不动,空串/缺失行用 defaultBlock 写入。
 *
 * 用法:  npm run db:backfill-prompts
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DEFAULT_SYSTEM_PROMPT,
  PROMPT_BLOCK_META,
  PROMPT_BLOCK_ORDER,
} from '../src/lib/prompts';

type DbLike = Prisma.TransactionClient | Pick<PrismaClient, 'setting'>;

export const PROMPT_BACKFILL: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'ai_system_prompt', value: DEFAULT_SYSTEM_PROMPT },
  ...PROMPT_BLOCK_ORDER.map((id) => ({
    key: PROMPT_BLOCK_META[id].key,
    value: PROMPT_BLOCK_META[id].defaultBlock,
  })),
];

export async function runBackfill(db: DbLike): Promise<{ filled: number; skipped: number }> {
  let filled = 0;
  let skipped = 0;
  for (const { key, value } of PROMPT_BACKFILL) {
    const existing = await db.setting.findUnique({ where: { key } });
    if (existing && existing.value && existing.value.length > 0) {
      skipped += 1; // 已有用户自定义内容,不动
      continue;
    }
    await db.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    filled += 1;
  }
  console.log(`[backfill-prompt-defaults] 回填 ${filled} 条,跳过 ${skipped} 条(已有自定义内容)`);
  return { filled, skipped };
}

const isMain =
  typeof import.meta.url === 'string' &&
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const db = new PrismaClient();
  runBackfill(db)
    .catch((err) => {
      console.error('[backfill-prompt-defaults] 失败:', err);
      process.exit(1);
    })
    .finally(() => db.$disconnect());
}
