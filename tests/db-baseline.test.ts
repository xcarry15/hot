/**
 * db-baseline 集成测试
 *
 * 覆盖场景:
 *  1. baseline structure matching: stdout DB 仅含 baseline 结构且无
 *     _prisma_migrations → precheck 通过,resolve 成功
 *  2. 重复执行 → already-applied
 *  3. 存量库仅含 baseline structure(带 fetchIntervalMin/avgScore),
 *     预检通过 → resolve → migrate deploy 应用 #2 → 数据/外键完整,
 *     旧列与派生缓存列删除,迁移记录正确(端到端)
 *  4. 存 DDB 有 drift(多表)→ 预检不通过,绝不写 _prisma_migrations
 *  5. _prisma_migrations 已含非 baseline 记录 → unexpected-history
 *  6. 新空库 migrate deploy → 全 migration 应用 → diff 验证无漂移
 *  7. resolveDbUrl 单元测试
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASELINE_MIGRATION, resolveDbUrl, runBaseline } from '../scripts/db-baseline';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(PROJECT_ROOT, 'prisma', 'schema.prisma');
const BASELINE_SQL = path.join(
  PROJECT_ROOT, 'prisma', 'migrations', BASELINE_MIGRATION, 'migration.sql',
);
// 第二条 migration(由重构 #3 引入,删除 fetchIntervalMin + avgScore)
const DROP_FIELDS_MIGRATION = '20260102000000_drop_per_source_fields';
const JOB_PROGRESS_MIGRATION = '20260103000000_add_job_progress_snapshot';
const LOG_INDEX_MIGRATION = '20260104000000_add_log_query_indexes';
const REDUNDANT_CACHE_MIGRATION = '20260713100000_remove_redundant_article_caches';

const TEST_TMP = mkdtempSync(path.join(tmpdir(), 'db-baseline-test-'));
const PRISMA_COMMAND_TIMEOUT_MS = 120_000;
const TSX_QUERY_TIMEOUT_MS = 30_000;

function tmpDbPath(name: string): string {
  return path.join(TEST_TMP, `${name}.db`);
}

function locatePrismaEntry(): { binary: string; prefixArgs: string[] } {
  const entry = path.join(PROJECT_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  if (!existsSync(entry)) throw new Error(`prisma entry not found at ${entry}. Run "npm install" first.`);
  return { binary: process.execPath, prefixArgs: [entry] };
}

function buildChildEnv(databaseUrl: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  env.DATABASE_URL = databaseUrl;
  return env;
}

function prismaDbExecute(absoluteDbPath: string, payload: { sql?: string; file?: string }): void {
  const args = ['db', 'execute', '--url', `file:${absoluteDbPath}`];
  if (payload.sql !== undefined) args.push('--stdin');
  else if (payload.file) args.push('--file', payload.file);
  else throw new Error('prismaDbExecute requires sql or file');

  const { binary, prefixArgs } = locatePrismaEntry();
  execFileSync(binary, [...prefixArgs, ...args], {
    cwd: PROJECT_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: buildChildEnv(`file:${absoluteDbPath}`) as unknown as NodeJS.ProcessEnv,
    input: payload.sql,
    timeout: PRISMA_COMMAND_TIMEOUT_MS,
  });
}

/** 应用 baseline migration SQL(仅 #1),模拟 db push 维护的存量库 */
function applyBaselineSql(absoluteDbPath: string): void {
  prismaDbExecute(absoluteDbPath, { file: BASELINE_SQL });
}

/** 应用全部 migration,模拟 migrate deploy 后的完整库 */
function applyAllMigrations(absoluteDbPath: string): void {
  const { binary, prefixArgs } = locatePrismaEntry();
  execFileSync(binary, [...prefixArgs, 'migrate', 'deploy'], {
    cwd: PROJECT_ROOT, stdio: 'pipe', encoding: 'utf8',
    env: buildChildEnv(`file:${absoluteDbPath}`) as unknown as NodeJS.ProcessEnv,
    timeout: PRISMA_COMMAND_TIMEOUT_MS,
  });
}

/** 清空 _prisma_migrations 表,模拟"从未接入 Prisma Migrate"（保留备用,当前测试通过 applyBaselineSql 直接模拟） */
void function _clearMigrationsTable(absoluteDbPath: string): void {
  prismaDbExecute(absoluteDbPath, { sql: 'DELETE FROM _prisma_migrations;' });
};

/** 注入 row SQL,直接操作指定 DB */
function execRawSql(absoluteDbPath: string, sql: string): void {
  prismaDbExecute(absoluteDbPath, { sql });
}

interface MigrationRow { migration_name: string; applied_steps_count: string | number; }

function queryMigrations(absoluteDbPath: string): MigrationRow[] {
  const scriptPath = path.join(PROJECT_ROOT, '.test-tmp-query.mjs');
  const url = `file:${absoluteDbPath}`;
  writeFileSync(scriptPath, `import { PrismaClient } from '@prisma/client';
try {
  const db = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(url)} } } });
  const rows = await db.$queryRawUnsafe('SELECT migration_name, applied_steps_count FROM _prisma_migrations');
  process.stdout.write(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  await db.$disconnect();
} catch (e) {
  if (/no such table: _prisma_migrations/i.test((e && e.message) || '')) { process.stdout.write('[]'); process.exit(0); }
  throw e;
}`, 'utf8');
  try {
    const out = runTsxScript(scriptPath);
    return out.trim() ? JSON.parse(out.trim()) as MigrationRow[] : [];
  } finally { try { rmSync(scriptPath); } catch {} }
}

function runTsxScript(scriptPath: string): string {
  const tsxEntry = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(tsxEntry)) throw new Error(`tsx entry not found at ${tsxEntry}. Run "npm install" first.`);
  return execFileSync(process.execPath, [tsxEntry, scriptPath], {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: TSX_QUERY_TIMEOUT_MS,
  });
}

function ensureEmptyDb(name: string): string {
  const p = tmpDbPath(name);
  writeFileSync(p, '', 'utf8');
  return p;
}

beforeAll(() => { expect(existsSync(BASELINE_SQL)).toBe(true); });
afterEach(async () => { await new Promise((r) => setTimeout(r, 50)); });
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  if (existsSync(TEST_TMP)) try { rmSync(TEST_TMP, { recursive: true, force: true }); } catch {}
});

describe('resolveDbUrl', () => {
  it('rewrites relative file URLs against the schema directory', () => {
    const absolute = resolveDbUrl('file:../db/custom.db', SCHEMA_PATH);
    const expected = 'file:' + path.resolve(path.dirname(SCHEMA_PATH), '../db/custom.db');
    expect(absolute).toBe(expected);
  });
  it('keeps absolute file URLs unchanged', () => {
    expect(resolveDbUrl('file:C:/abs/path.db', SCHEMA_PATH)).toBe('file:C:/abs/path.db');
    expect(resolveDbUrl('file:/abs/path.db', SCHEMA_PATH)).toBe('file:/abs/path.db');
  });
  it('leaves non-file URLs untouched', () => {
    expect(resolveDbUrl('postgresql://x', SCHEMA_PATH)).toBe('postgresql://x');
  });
});

describe('runBaseline — integration with temp SQLite', () => {
  it('refuses to baseline an empty database (drift, exit 2)', async () => {
    const dbPath = ensureEmptyDb('empty');
    const result = await runBaseline({ databaseUrl: 'file:' + dbPath, schemaPath: SCHEMA_PATH });
    expect(result.outcome).toBe('drift');
    expect(result.precheck.status).toBe(2);
    expect(result.precheck.stdout).toMatch(/Added tables|sources/);
    expect(queryMigrations(dbPath)).toEqual([]);
  }, 60_000);

  it('applies baseline on a database whose structure matches baseline migration', async () => {
    const dbPath = ensureEmptyDb('matching');
    applyBaselineSql(dbPath);
    // 此库仅含 baseline 结构(含 fetchIntervalMin/avgScore),
    // 且 _prisma_migrations 不存在 → 无先前记录
    const result = await runBaseline({ databaseUrl: 'file:' + dbPath, schemaPath: SCHEMA_PATH });
    expect(result.outcome).toBe('applied');
    expect(result.precheck.status).toBe(0);
    expect(result.resolve?.status).toBe(0);

    const rows = queryMigrations(dbPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.migration_name).toBe(BASELINE_MIGRATION);
    expect(String(rows[0]?.applied_steps_count)).toBe('0');
  }, 60_000);

  it('is idempotent on re-run (already-applied, exit 0, precheck skipped)', async () => {
    const dbPath = ensureEmptyDb('idempotent');
    applyBaselineSql(dbPath);
    const first = await runBaseline({ databaseUrl: 'file:' + dbPath, schemaPath: SCHEMA_PATH });
    expect(first.outcome).toBe('applied');

    const second = await runBaseline({ databaseUrl: 'file:' + dbPath, schemaPath: SCHEMA_PATH });
    expect(second.outcome).toBe('already-applied');
    // precheck 在 already-applied 分支被跳过,保持不变
    expect(second.resolve).toBeUndefined();
    expect(queryMigrations(dbPath)).toHaveLength(1);
  }, 60_000);

  it('refuses to baseline a drifted database (extra table vs baseline structure)', async () => {
    const dbPath = ensureEmptyDb('drifted');
    applyBaselineSql(dbPath);
    execRawSql(dbPath, 'CREATE TABLE extra_legacy (id INTEGER PRIMARY KEY, payload TEXT);');

    const result = await runBaseline({ databaseUrl: 'file:' + dbPath, schemaPath: SCHEMA_PATH });
    expect(result.outcome).toBe('drift');
    expect(result.precheck.status).toBe(2);
    expect(result.precheck.stdout).toMatch(/extra_legacy/);
    expect(result.resolve).toBeUndefined();
    expect(queryMigrations(dbPath)).toEqual([]);
  }, 60_000);
});

describe('runBaseline — migration history protection', () => {
  it('refuses to add baseline when non-baseline records exist', async () => {
    const dbPath = ensureEmptyDb('has-history');
    applyBaselineSql(dbPath);
    // 手工建 _prisma_migrations 并插入历史记录,模拟"早已接入 migrate"
    execRawSql(dbPath,
      `CREATE TABLE _prisma_migrations (
        id TEXT PRIMARY KEY, checksum TEXT NOT NULL, finished_at DATETIME,
        migration_name TEXT NOT NULL, logs TEXT, rolled_back_at DATETIME,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        applied_steps_count INTEGER NOT NULL DEFAULT 0
      );`);
    execRawSql(dbPath, `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
      VALUES ('h1','fh',CURRENT_TIMESTAMP,'20240901000000_legacy_init',CURRENT_TIMESTAMP,1);`);

    const before = queryMigrations(dbPath);
    expect(before.map(r => r.migration_name)).toEqual(['20240901000000_legacy_init']);

    const result = await runBaseline({ databaseUrl: 'file:' + dbPath, schemaPath: SCHEMA_PATH });
    expect(result.outcome).toBe('unexpected-history');
    expect(result.unexpectedMigrations).toEqual(['20240901000000_legacy_init']);
    expect(result.resolve).toBeUndefined();
    // baseline 行绝不会被追加
    expect(queryMigrations(dbPath)).toEqual(before);
  }, 60_000);
});

describe('prisma migrate deploy — empty database integration', () => {
  it('applies all migrations on an empty SQLite, then migrate diff reports no drift', async () => {
    const dbPath = ensureEmptyDb('migrate-deploy');
    applyAllMigrations(dbPath);

    const rows = queryMigrations(dbPath);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) expect(String(r.applied_steps_count)).toBe('1');

    let diffStatus = 0;
    try {
      const { binary, prefixArgs } = locatePrismaEntry();
      execFileSync(binary, [...prefixArgs, 'migrate', 'diff', '--from-url', `file:${dbPath}`, '--to-schema-datamodel', SCHEMA_PATH, '--exit-code'],
        { cwd: PROJECT_ROOT, stdio: 'pipe', encoding: 'utf8', env: buildChildEnv(`file:${dbPath}`) as unknown as NodeJS.ProcessEnv, timeout: PRISMA_COMMAND_TIMEOUT_MS });
    } catch (err: unknown) { diffStatus = typeof (err as { status?: number }).status === 'number' ? (err as { status: number }).status : 1; }
    expect(diffStatus).toBe(0);

    // 此时 baseline 已记录且后续 migration 已应用,runBaseline 返回 already-applied
    const result = await runBaseline({ databaseUrl: 'file:' + dbPath, schemaPath: SCHEMA_PATH });
    expect(result.outcome).toBe('already-applied');
  }, 120_000);
});

describe('E2E: legacy db-push DB → baseline → migrate deploy', () => {
  it('baseline-only structure → resolve → deploy → data/keys intact, columns dropped, two records', async () => {
    const dbPath = ensureEmptyDb('e2e-legacy');

    // 模拟 db push 维护的存量环境:
    //   applyBaselineSql 建出含 fetchIntervalMin(25)/avgScore(78) 的 sources 行
    applyBaselineSql(dbPath);
    execRawSql(dbPath,
      `INSERT INTO sources (id, name, type, url, parserConfig, enabled, status, consecutiveFailures,
        circuitBreakerUntil, lastFetchedAt, fetchIntervalMin, avgScore, totalArticles,
        createdAt, updatedAt)
       VALUES ('s1','Test','html','https://x.com','{}',1,'normal',0,NULL,NULL,25,78,10,
         '2025-07-01','2025-07-01');`);
    // 插入关联 article(外键引用 source)
    execRawSql(dbPath,
      `INSERT INTO articles (id, sourceId, url, title, updatedAt) VALUES ('a1','s1','https://x.com/a','Hello','2025-07-01');`);

    // 状态 A: 存量库, 无 _prisma_migrations, 含 fetchIntervalMin/avgScore
    const colsBefore = checkTableColumns(dbPath, 'sources');
    expect(colsBefore).toContain('fetchIntervalMin');
    expect(colsBefore).toContain('avgScore');

    // 1) baseline resolve
    const baselineRes = await runBaseline({ databaseUrl: 'file:' + dbPath, schemaPath: SCHEMA_PATH });
    expect(baselineRes.outcome).toBe('applied');
    expect(queryMigrations(dbPath).map(r => r.migration_name)).toEqual([BASELINE_MIGRATION]);

    // 2) migrate deploy — 应应用 #2(删列)
    applyAllMigrations(dbPath);

    // 3) 迁移记录: baseline + 历史迁移 + 派生缓存清理迁移
    const migrationsAfter = queryMigrations(dbPath);
    expect(migrationsAfter).toHaveLength(5);
    const baselineRow = migrationsAfter.find(r => r.migration_name === BASELINE_MIGRATION);
    const dropRow = migrationsAfter.find(r => r.migration_name === DROP_FIELDS_MIGRATION);
    const progressRow = migrationsAfter.find(r => r.migration_name === JOB_PROGRESS_MIGRATION);
    const logIndexRow = migrationsAfter.find(r => r.migration_name === LOG_INDEX_MIGRATION);
    const redundantCacheRow = migrationsAfter.find(r => r.migration_name === REDUNDANT_CACHE_MIGRATION);
    expect(baselineRow).toBeDefined();
    expect(dropRow).toBeDefined();
    expect(progressRow).toBeDefined();
    expect(logIndexRow).toBeDefined();
    expect(redundantCacheRow).toBeDefined();
    // baseline 由 resolve --applied 写入(applied_steps_count=0),
    // #2 由 migrate deploy 实际执行(applied_steps_count=1)。
    expect(String(baselineRow!.applied_steps_count)).toBe('0');
    expect(String(dropRow!.applied_steps_count)).toBe('1');
    expect(String(progressRow!.applied_steps_count)).toBe('1');
    expect(String(logIndexRow!.applied_steps_count)).toBe('1');
    expect(String(redundantCacheRow!.applied_steps_count)).toBe('1');
    // 防回归:精确名称断言(防止 #2 改名后漂移不被察觉)
    const names = migrationsAfter.map(r => r.migration_name).sort();
    expect(names).toEqual([BASELINE_MIGRATION, DROP_FIELDS_MIGRATION, JOB_PROGRESS_MIGRATION, LOG_INDEX_MIGRATION, REDUNDANT_CACHE_MIGRATION].sort());

    // 4) 数据完整: 旧行保留, 新列已删除
    const colsAfter = checkTableColumns(dbPath, 'sources');
    expect(colsAfter).not.toContain('fetchIntervalMin');
    expect(colsAfter).not.toContain('avgScore');
    // verify source row survived
    const sources = queryTable(dbPath, 'SELECT id, name FROM sources');
    expect(sources).toEqual([{ id: 's1', name: 'Test' }]);

    // 5) 外键 intact(article 仍可 JOIN source)
    const articles = queryTable(dbPath,
      'SELECT a.id, a.url, s.name as srcName FROM articles a JOIN sources s ON a.sourceId = s.id');
    expect(articles).toEqual([{ id: 'a1', url: 'https://x.com/a', srcName: 'Test' }]);

    // 5b) 外键定义仍存在(articles.sourceId -> sources.id)
    const fkList = queryTable(dbPath, "PRAGMA foreign_key_list('articles')");
    expect(fkList.length).toBeGreaterThan(0);
    const fk = fkList[0] as { from: string; table: string; to: string };
    expect(fk.from).toBe('sourceId');
    expect(fk.table).toBe('sources');
    expect(fk.to).toBe('id');

    // 5c) PRAGMA foreign_key_check 必须返回 0 行(无孤儿引用)
    const fkViolations = queryTable(dbPath, 'PRAGMA foreign_key_check');
    expect(fkViolations).toEqual([]);

    // 6) diff 验证: 最终库与当前 schema 无差异
    let diffStatus = 0;
    try {
      const { binary, prefixArgs } = locatePrismaEntry();
      execFileSync(binary, [...prefixArgs, 'migrate', 'diff', '--from-url', `file:${dbPath}`, '--to-schema-datamodel', SCHEMA_PATH, '--exit-code'],
        { cwd: PROJECT_ROOT, stdio: 'pipe', encoding: 'utf8', env: buildChildEnv(`file:${dbPath}`) as unknown as NodeJS.ProcessEnv, timeout: PRISMA_COMMAND_TIMEOUT_MS });
    } catch (err: unknown) { diffStatus = typeof (err as { status?: number }).status === 'number' ? (err as { status: number }).status : 1; }
    expect(diffStatus).toBe(0);
  }, 300_000);
});

// ---- helpers ----

function checkTableColumns(absoluteDbPath: string, table: string): string[] {
  const scriptPath = path.join(PROJECT_ROOT, '.test-tmp-cols.mjs');
  const url = `file:${absoluteDbPath.replace(/\\/g, '/')}`;
  writeFileSync(scriptPath, `import { PrismaClient } from '@prisma/client';
const db = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(url)} } } });
const cols = await db.$queryRawUnsafe("PRAGMA table_info(${table})");
process.stdout.write(JSON.stringify(cols.map(c => c.name)));
await db.$disconnect();`, 'utf8');
  try {
    const out = runTsxScript(scriptPath);
    return JSON.parse(out.trim()) as string[];
  } finally { try { rmSync(scriptPath); } catch {} }
}

function queryTable(absoluteDbPath: string, sql: string): unknown[] {
  const scriptPath = path.join(PROJECT_ROOT, '.test-tmp-query.mjs');
  const url = `file:${absoluteDbPath.replace(/\\/g, '/')}`;
  writeFileSync(scriptPath, `import { PrismaClient } from '@prisma/client';
const db = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(url)} } } });
const rows = await db.$queryRawUnsafe(\`${sql}\`);
process.stdout.write(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
await db.$disconnect();`, 'utf8');
  try {
    const out = runTsxScript(scriptPath);
    return JSON.parse(out.trim()) as unknown[];
  } finally { try { rmSync(scriptPath); } catch {} }
}
