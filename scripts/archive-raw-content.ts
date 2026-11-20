/**
 * 可选的、手动执行的 articles.rawContent 归档/清理工具。
 *
 * 背景：线上 rawContent 合计 174.5 MB / 297 MB 库（59%），3322 篇平均 ~55 KB
 * 原始 HTML 永久保留，放大 WAL、备份、VACUUM 与锁竞争成本。本脚本把超过时间
 * 窗口的 rawContent 导出为 NDJSON 备份后置空（schema 为 String @default("")，
 * 不可为 null，因此用空串表示已归档）。
 *
 * 硬性约定：
 *   - 默认 dry-run：只统计，不写备份文件、不改数据库。
 *   - 只有显式 --apply 才会落盘备份并执行更新；绝不由定时任务或部署脚本自动调用。
 *   - 先备份再改：每批 NDJSON 完全写入备份文件后，才用独立事务更新该批。
 *   - 可回滚：--apply --restore <备份.ndjson> 从备份逐批恢复。
 *   - 按时间（--before / --older-than-days）与大小（--max-bytes、--batch-size）
 *     分批；单批默认 100 篇、单批一个事务，避免大事务与全内存拼接。
 *
 * 执行（需要 DATABASE_URL 环境变量，与项目其它 tsx 脚本一致）：
 *   npx tsx scripts/archive-raw-content.ts --help
 *   npx tsx scripts/archive-raw-content.ts --dry-run --older-than-days 90
 *   npx tsx scripts/archive-raw-content.ts --apply --older-than-days 90 \
 *       --output /www/backup/h2-hot2/raw-content
 *   npx tsx scripts/archive-raw-content.ts --apply --restore \
 *       /www/backup/h2-hot2/raw-content/raw-content-<时间戳>.ndjson
 *
 * 建议：在维护窗口、PM2 停止或业务低峰执行；本脚本不停止 PM2、不改 .env、
 * 不注册 cron、不触碰 log-retention.ts。执行前后请自行核对 DB 一致性。
 */
import { PrismaClient } from '@prisma/client';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

interface Options {
  dryRun: boolean;
  apply: boolean;
  restore?: string;
  before?: Date;
  olderThanDays: number;
  batchSize: number;
  maxBytes: number;
  outputDir: string;
  help: boolean;
}

interface ArchiveRow {
  id: string;
  rawContent: string;
}

const USAGE = `用法：npx tsx scripts/archive-raw-content.ts [选项]

  --dry-run                 默认；只统计，不写备份、不改数据库
  --apply                    实际执行（必须显式给出）
  --restore <file>          从 NDJSON 备份恢复 rawContent（配合 --apply 才写库）
  --before <ISO 日期>        只处理 createdAt 早于该时间的文章
  --older-than-days <N>     按天数计算截止时间，默认 90（--before 优先）
  --batch-size <N>         每批篇数、每批一个事务，默认 100
  --max-bytes <N>           本次最多归档的原始字节数，0 表示不限，默认 0
  --output <dir>            备份目录，默认 ./backups/raw-content
  -h, --help                 显示本说明

示例：
  npx tsx scripts/archive-raw-content.ts --dry-run --older-than-days 90
  npx tsx scripts/archive-raw-content.ts --apply --older-than-days 90 --output /www/backup/h2-hot2/raw-content
  npx tsx scripts/archive-raw-content.ts --apply --restore /www/backup/h2-hot2/raw-content/raw-content-XXX.ndjson`;

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} 缺少取值`);
  }
  return value;
}

function parseIntOption(raw: string, flag: string, allowZero: boolean): number {
  const value = Number(raw);
  const lowerBound = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < lowerBound) {
    throw new Error(`${flag} 必须是${allowZero ? '非负' : '正'}整数，收到：${raw}`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: true,
    apply: false,
    restore: undefined,
    before: undefined,
    olderThanDays: 90,
    batchSize: 100,
    maxBytes: 0,
    outputDir: path.resolve(process.cwd(), 'backups/raw-content'),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--apply':
        options.apply = true;
        options.dryRun = false;
        break;
      case '--dry-run':
        options.dryRun = true;
        options.apply = false;
        break;
      case '--restore':
        options.restore = path.resolve(requireValue(argv, ++index, arg));
        break;
      case '--before':
        options.before = new Date(requireValue(argv, ++index, arg));
        break;
      case '--older-than-days':
        options.olderThanDays = parseIntOption(requireValue(argv, ++index, arg), arg, false);
        break;
      case '--batch-size':
        options.batchSize = parseIntOption(requireValue(argv, ++index, arg), arg, false);
        break;
      case '--max-bytes':
        options.maxBytes = parseIntOption(requireValue(argv, ++index, arg), arg, true);
        break;
      case '--output':
        options.outputDir = path.resolve(requireValue(argv, ++index, arg));
        break;
      default:
        throw new Error(`未知参数：${arg}（用 --help 查看用法）`);
    }
  }
  if (options.before && Number.isNaN(options.before.getTime())) {
    throw new Error('--before 不是合法日期');
  }
  if (options.restore && options.before) {
    throw new Error('--restore 与 --before 不可同时使用');
  }
  return options;
}

function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function archive(db: PrismaClient, options: Options): Promise<void> {
  const cutoff = options.before
    ?? new Date(Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000);
  const backupPath = path.join(options.outputDir, `raw-content-${backupStamp()}.ndjson`);

  if (!options.dryRun) {
    mkdirSync(options.outputDir, { recursive: true });
    // 独占创建，避免覆盖既有备份；失败即中止，不动数据库。
    writeFileSync(backupPath, '', { encoding: 'utf8', flag: 'wx' });
  }

  let cursor: string | undefined;
  let scanned = 0;
  let archived = 0;
  let archivedBytes = 0;
  let batches = 0;
  let stop = false;

  while (!stop) {
    const rows = await db.article.findMany({
      where: {
        rawContent: { not: '' },
        createdAt: { lt: cutoff },
      },
      orderBy: { id: 'asc' },
      take: options.batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, rawContent: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    scanned += rows.length;

    const selected: ArchiveRow[] = [];
    let batchBytes = 0;
    for (const row of rows) {
      const size = Buffer.byteLength(row.rawContent, 'utf8');
      if (options.maxBytes > 0 && archivedBytes + batchBytes + size > options.maxBytes) {
        stop = true;
        break;
      }
      selected.push(row);
      batchBytes += size;
    }

    if (selected.length > 0) {
      if (!options.dryRun) {
        // 先备份：整批 NDJSON 落盘成功之后，才执行该批的数据库事务。
        appendFileSync(
          backupPath,
          `${selected.map((row) => JSON.stringify(row)).join('\n')}\n`,
          'utf8',
        );
        await db.$transaction(selected.map((row) => db.article.update({
          where: { id: row.id },
          data: { rawContent: '' },
        })));
      }
      archived += selected.length;
      archivedBytes += batchBytes;
      batches += 1;
    }
    if (rows.length < options.batchSize) break;
  }

  console.log('[archive-raw-content]', JSON.stringify({
    mode: options.dryRun ? 'dry-run' : 'apply',
    cutoff: cutoff.toISOString(),
    scanned,
    archived,
    archivedBytes,
    batches,
    backupPath: options.dryRun ? '(dry-run 未创建)' : backupPath,
  }));
}

async function restore(db: PrismaClient, options: Options): Promise<void> {
  const file = options.restore;
  if (!file) throw new Error('缺少 --restore 备份文件');
  if (!existsSync(file)) throw new Error(`备份文件不存在：${file}`);

  const reader = createInterface({
    input: createReadStream(file, 'utf8'),
    crlfDelay: Infinity,
  });
  let batch: ArchiveRow[] = [];
  let restored = 0;
  let batches = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    if (!options.dryRun) {
      await db.$transaction(batch.map((row) => db.article.update({
        where: { id: row.id },
        data: { rawContent: row.rawContent },
      })));
    }
    restored += batch.length;
    batches += 1;
    batch = [];
  };

  for await (const line of reader) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`备份行不是合法 JSON：${line.slice(0, 80)}`);
    }
    const row = parsed as { id?: unknown; rawContent?: unknown };
    if (typeof row.id !== 'string' || typeof row.rawContent !== 'string') {
      throw new Error(`备份行缺少 id/rawContent 字符串：${line.slice(0, 80)}`);
    }
    batch.push({ id: row.id, rawContent: row.rawContent });
    if (batch.length >= options.batchSize) await flush();
  }
  await flush();

  console.log('[archive-raw-content]', JSON.stringify({
    mode: options.dryRun ? 'dry-run' : 'apply',
    restore: file,
    restored,
    batches,
  }));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (options.dryRun) {
    console.log('[archive-raw-content] DRY-RUN：只统计，不写备份、不改数据库；显式加 --apply 才会实际执行。');
  }
  const db = new PrismaClient();
  try {
    if (options.restore) await restore(db, options);
    else await archive(db, options);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[archive-raw-content] 失败：', error);
  process.exitCode = 1;
});
