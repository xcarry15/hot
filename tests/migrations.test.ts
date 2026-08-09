import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(PROJECT_ROOT, 'prisma', 'schema.prisma');
const MIGRATIONS_PATH = path.join(PROJECT_ROOT, 'prisma', 'migrations');
const TEST_TMP = mkdtempSync(path.join(tmpdir(), 'hot2-migrations-test-'));
const DB_PATH = path.join(TEST_TMP, 'clean.db');
const DATABASE_URL = `file:${DB_PATH.replace(/\\/g, '/')}`;
const INCREMENTAL_DB_PATH = path.join(TEST_TMP, 'incremental.db');
const INCREMENTAL_PRISMA_PATH = path.join(TEST_TMP, 'incremental-prisma');
const INCREMENTAL_SCHEMA_PATH = path.join(INCREMENTAL_PRISMA_PATH, 'schema.prisma');
const INCREMENTAL_MIGRATIONS_PATH = path.join(INCREMENTAL_PRISMA_PATH, 'migrations');
const INCREMENTAL_DATABASE_URL = `file:${INCREMENTAL_DB_PATH.replace(/\\/g, '/')}`;
const COMMAND_TIMEOUT_MS = 180_000;

function prismaEntry(): string {
  const entry = path.join(PROJECT_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  if (!existsSync(entry)) throw new Error(`Prisma CLI 不存在：${entry}`);
  return entry;
}

function runPrisma(args: string[], databaseUrl = DATABASE_URL): string {
  return execFileSync(process.execPath, [prismaEntry(), ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: COMMAND_TIMEOUT_MS,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

afterAll(() => {
  rmSync(TEST_TMP, { recursive: true, force: true });
});

describe('Prisma migration smoke', () => {
  it('空 SQLite 可应用全部 migration，且最终结构与 schema 无漂移', () => {
    writeFileSync(DB_PATH, '');

    const deployOutput = runPrisma(['migrate', 'deploy']);
    expect(deployOutput).toMatch(/migrations have been successfully applied|No pending migrations/i);

    expect(() => runPrisma([
      'migrate', 'diff',
      '--from-url', DATABASE_URL,
      '--to-schema-datamodel', SCHEMA_PATH,
      '--exit-code',
    ])).not.toThrow();
  }, 240_000);

  it('已有当前 migration 链前缀时，可增量应用后续 migration', () => {
    const migrationNames = readdirSync(MIGRATIONS_PATH, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const latestMigration = migrationNames.at(-1);
    if (!latestMigration) throw new Error('当前 migration 链为空');

    cpSync(SCHEMA_PATH, INCREMENTAL_SCHEMA_PATH);
    cpSync(MIGRATIONS_PATH, INCREMENTAL_MIGRATIONS_PATH, { recursive: true });
    rmSync(path.join(INCREMENTAL_MIGRATIONS_PATH, latestMigration), {
      recursive: true,
      force: true,
    });
    writeFileSync(INCREMENTAL_DB_PATH, '');

    const deployArgs = ['migrate', 'deploy', '--schema', INCREMENTAL_SCHEMA_PATH];
    expect(() => runPrisma(deployArgs, INCREMENTAL_DATABASE_URL)).not.toThrow();

    cpSync(
      path.join(MIGRATIONS_PATH, latestMigration),
      path.join(INCREMENTAL_MIGRATIONS_PATH, latestMigration),
      { recursive: true },
    );
    expect(() => runPrisma(deployArgs, INCREMENTAL_DATABASE_URL)).not.toThrow();
    expect(() => runPrisma([
      'migrate', 'diff',
      '--from-url', INCREMENTAL_DATABASE_URL,
      '--to-schema-datamodel', INCREMENTAL_SCHEMA_PATH,
      '--exit-code',
    ], INCREMENTAL_DATABASE_URL)).not.toThrow();
  }, 240_000);
});
