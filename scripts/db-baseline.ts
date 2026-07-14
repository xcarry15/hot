/**
 * 把 init_baseline migration 标记为"已应用",专供已经使用 db push
 * 维护表结构的存量库一次性接入 Prisma Migrate。后续所有部署一律
 * 改走 `prisma migrate deploy`,本脚本仅在首次切换时执行一次。
 *
 * 安全约束(来自重构报告 #2):
 *  1. 漂移预检必须与 **baseline migration 的精确结构** 比较,而非当前
 *     schema.prisma(后者已被后续 migration 修改)：
 *       1. 先以 baseline migration SQL 在临时 SQLite 中重建精确 snapshot
 *       2. `prisma migrate diff --from-url "$DATABASE_URL" --to-url "file:<tmp-baseline-db>" --exit-code`
 *          - exit 0: 存量库与 baseline 结构一致,允许 resolve
 *          - exit 2: 存在 schema drift,立即停止,不写 _prisma_migrations
 *          - exit 1: 命令失败,停止。
 *  2. 迁移历史保护:_prisma_migrations 已存在任何非 baseline 记录时
 *     立即失败(exit 2),绝不追加 baseline。这种情况说明该库早已接入
 *     Prisma Migrate,应走 `prisma migrate deploy` 应用新 migration。
 *  3. 检查顺序:先读 _prisma_migrations → baseline 已记录则 already-applied;
 *     有非 baseline 记录则 unexpected-history;都无则做漂移预检 + resolve。
 *     precheck 放在读表后,可避免后续 schema 变更导致的虚假 drift 误报。
 *  4. 本脚本只标记 baseline,绝不修改 schema。后续 schema 变更必须
 *     通过 `npx prisma migrate dev --name <name>` 生成新迁移。
 *  5. 所有 prisma CLI 调用走 execFileSync + 数组参数,无 shell:true
 *     和字符串拼接,URL/路径不会因特殊字符被错误解释。
 *
 * 用法:
 *   DATABASE_URL=file:../db/custom.db npm run db:migrate:baseline
 */
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE_MIGRATION = '20260101000000_init_baseline';
const PRISMA_COMMAND_TIMEOUT_MS = 120_000;
const SCHEMA_PATH = path.join(process.cwd(), 'prisma', 'schema.prisma');

function loadDotenv(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    if (m[1] in process.env) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}

interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

function locatePrismaEntry(): { binary: string; prefixArgs: string[] } {
  const entry = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(
      `prisma entry not found at ${entry}. Run "npm install" first.`,
    );
  }
  return { binary: process.execPath, prefixArgs: [entry] };
}

/**
 * 用 execFileSync + 数组参数调用 prisma CLI,无 shell:true 和字符串拼接。
 */
function runPrisma(args: string[], env: Record<string, string>): ExecResult {
  const { binary, prefixArgs } = locatePrismaEntry();
  try {
    const stdout = execFileSync(binary, [...prefixArgs, ...args], {
      stdio: 'pipe',
      encoding: 'utf8',
      env: env as unknown as NodeJS.ProcessEnv,
      timeout: PRISMA_COMMAND_TIMEOUT_MS,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
    };
  }
}

function buildChildEnv(absoluteDbUrl: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  out.DATABASE_URL = absoluteDbUrl;
  return out;
}

export function resolveDbUrl(dbUrl: string, schemaPath: string): string {
  if (!dbUrl.startsWith('file:')) return dbUrl;
  const tail = dbUrl.slice('file:'.length);
  if (/^[a-zA-Z]:[\\/]/.test(tail) || tail.startsWith('/')) return dbUrl;
  const baseDir = path.dirname(path.resolve(schemaPath));
  const absolute = path.resolve(baseDir, tail);
  return 'file:' + absolute;
}

export interface BaselineOptions {
  databaseUrl?: string;
  schemaPath?: string;
}

export interface BaselineResult {
  outcome:
    | 'applied'
    | 'already-applied'
    | 'drift'
    | 'precheck-failed'
    | 'resolve-failed'
    | 'unexpected-history';
  precheck: { status: number; stdout: string; stderr: string };
  resolve?: { status: number; stdout: string; stderr: string };
  message: string;
  unexpectedMigrations?: string[];
}

interface MigrationHistory {
  appliedBaseline: boolean;
  others: string[];
}

async function readMigrationHistory(absoluteDbUrl: string): Promise<MigrationHistory> {
  const prisma = new PrismaClient({ datasources: { db: { url: absoluteDbUrl } } });
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
      `SELECT migration_name FROM _prisma_migrations`,
    );
    const list = Array.isArray(rows) ? rows.map((r) => r.migration_name) : [];
    return {
      appliedBaseline: list.includes(BASELINE_MIGRATION),
      others: list.filter((n) => n !== BASELINE_MIGRATION),
    };
  } catch (err) {
    // 只有 _prisma_migrations 表不存在(典型场景:存量 db-push 库)才视为"未接入";
    // 其他错误(连接失败、权限拒绝、文件损坏等)必须向上抛,不能被吞掉。
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table: _prisma_migrations/i.test(msg)) {
      return { appliedBaseline: false, others: [] };
    }
    throw err;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

/**
 * 用 baseline migration SQL 在独立临时 SQLite 里重建精确结构 snapshot,
 * 返回 temp DB 绝对路径。这是预检的基准——存量库必须与 baseline
 * 结构一致,而非与当前 schema.prisma(已被后续 migration 修改)一致。
 *
 * 调用方负责在 finally 中清理返回路径所在目录(本函数也会保留路径供调用方使用)。
 * 若 `prisma db execute` 退出非零,抛错(由 runBaseline 捕获并转 precheck-failed)。
 */
export function buildBaselineSnapshot(childEnv: Record<string, string>): { snapshotDir: string; snapshotPath: string } {
  const baselineSqlPath = path.join(
    path.dirname(SCHEMA_PATH),
    'migrations',
    BASELINE_MIGRATION,
    'migration.sql',
  );
  if (!existsSync(baselineSqlPath)) {
    throw new Error(`baseline migration SQL not found at ${baselineSqlPath}`);
  }

  const snapshotDir = mkdtempSync(path.join(tmpdir(), 'baseline-snapshot-'));
  const snapshotPath = path.join(snapshotDir, 'baseline.db');
  writeFileSync(snapshotPath, '', 'utf8');
  const snapshotUrl = 'file:' + snapshotPath;

  // 把 baseline SQL 用到临时空库,得到精确的 baseline 表结构。
  // 退出码非零立即抛错,runBaseline 会转为 precheck-failed。
  const result = runPrisma(
    ['db', 'execute', '--url', snapshotUrl, '--file', baselineSqlPath],
    { ...childEnv, DATABASE_URL: snapshotUrl },
  );
  if (result.status !== 0) {
    // 失败时立刻清理临时目录,不留垃圾
    try { rmSync(snapshotDir, { recursive: true, force: true }); } catch {}
    throw new Error(
      `prisma db execute on baseline snapshot failed (exit ${result.status}).\nStdout: ${result.stdout}\nStderr: ${result.stderr}`,
    );
  }

  return { snapshotDir, snapshotPath };
}

export async function runBaseline(opts: BaselineOptions = {}): Promise<BaselineResult> {
  loadDotenv();
  const dbUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!dbUrl) {
    return {
      outcome: 'precheck-failed',
      precheck: { status: 1, stdout: '', stderr: '' },
      message: 'DATABASE_URL is not set. Check your .env file.',
    };
  }
  const schemaPath = opts.schemaPath ?? SCHEMA_PATH;
  if (!existsSync(schemaPath)) {
    return {
      outcome: 'precheck-failed',
      precheck: { status: 1, stdout: '', stderr: '' },
      message: `schema not found at ${schemaPath}`,
    };
  }

  const absoluteDbUrl = resolveDbUrl(dbUrl, schemaPath);
  const childEnv = buildChildEnv(absoluteDbUrl);

  // 1) 迁移历史保护与幂等检查(必须在漂移预检之前):
  //    - baseline 已记录 → already-applied,直接返回(预检跳过)
  //    - 有非 baseline 记录 → unexpected-history,停止
  //    - 都没有 → 才进入基线预检
  const history = await readMigrationHistory(absoluteDbUrl);

  if (history.appliedBaseline) {
    return {
      outcome: 'already-applied',
      precheck: { status: 0, stdout: '', stderr: '' },
      message: `Baseline migration ${BASELINE_MIGRATION} already recorded in _prisma_migrations. Nothing to do.`,
    };
  }
  if (history.others.length > 0) {
    return {
      outcome: 'unexpected-history',
      precheck: { status: 2, stdout: '', stderr: '' },
      unexpectedMigrations: history.others,
      message:
        `_prisma_migrations 已包含非 baseline 记录(${history.others.join(', ')}),` +
        `该库应通过 \`prisma migrate deploy\` 应用新 migration,而不是用 baseline 脚本补行。` +
        `请人工检查后,选择删除多余记录 / 改用 \`db:migrate:deploy\`。`,
    };
  }

  // 2) 漂移预检:对比存量库与 baseline migration 的精确结构。
  //    用 baseline SQL 建临时 snapshot DB,再 migrate diff 比较两库结构。
  let snapshotDir: string | undefined;
  try {
    let snapshotPath: string;
    try {
      const snap = buildBaselineSnapshot(childEnv);
      snapshotDir = snap.snapshotDir;
      snapshotPath = snap.snapshotPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        outcome: 'precheck-failed',
        precheck: { status: 1, stdout: '', stderr: '' },
        message: `Failed to build baseline snapshot: ${msg}`,
      };
    }
    const snapshotUrl = 'file:' + snapshotPath;

    const precheck = runPrisma(
      ['migrate', 'diff', '--from-url', absoluteDbUrl, '--to-url', snapshotUrl, '--exit-code'],
      childEnv,
    );

    if (precheck.status === 2) {
      return {
        outcome: 'drift',
        precheck,
        message: `Schema drift detected against baseline structure. Baseline NOT applied. Diff:\n${
          precheck.stdout
        }${precheck.stderr ? '\nStderr:\n' + precheck.stderr : ''}`,
      };
    }
    if (precheck.status !== 0) {
      return {
        outcome: 'precheck-failed',
        precheck,
        message: `Precheck command failed (exit ${precheck.status}).\nStdout: ${precheck.stdout}\nStderr: ${precheck.stderr}`,
      };
    }

    // 3) 标记 applied
    const resolve = runPrisma(
      ['migrate', 'resolve', '--applied', BASELINE_MIGRATION, '--schema', schemaPath],
      childEnv,
    );
    if (resolve.status !== 0) {
      return {
        outcome: 'resolve-failed',
        precheck,
        resolve,
        message: `prisma migrate resolve failed (exit ${resolve.status}).\nStdout: ${resolve.stdout}\nStderr: ${resolve.stderr}`,
      };
    }

    return {
      outcome: 'applied',
      precheck,
      resolve,
      message: `Baseline migration ${BASELINE_MIGRATION} marked as applied.`,
    };
  } finally {
    // 清理临时 snapshot 目录(包括失败路径也确保不漏)
    if (snapshotDir && existsSync(snapshotDir)) {
      try { rmSync(snapshotDir, { recursive: true, force: true }); } catch {}
    }
  }
}

const isMain =
  typeof import.meta.url === 'string' &&
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  runBaseline()
    .then((result) => {
      if (result.outcome === 'applied' || result.outcome === 'already-applied') {
        console.log(`✓ ${result.message}`);
      } else {
        console.error(`✗ ${result.message}`);
      }
      const exitCode =
        result.outcome === 'applied' || result.outcome === 'already-applied'
          ? 0
          : result.outcome === 'drift' || result.outcome === 'unexpected-history'
            ? 2
            : 1;
      process.exit(exitCode);
    })
    .catch((err: unknown) => {
      console.error('✗ Unexpected error:', err);
      process.exit(1);
    });
}
