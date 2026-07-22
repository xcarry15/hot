import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(PROJECT_ROOT, 'prisma', 'schema.prisma');
const TEST_TMP = mkdtempSync(path.join(tmpdir(), 'hot2-migrations-test-'));
const DB_PATH = path.join(TEST_TMP, 'clean.db');
const DATABASE_URL = `file:${DB_PATH.replace(/\\/g, '/')}`;
const COMMAND_TIMEOUT_MS = 180_000;

function prismaEntry(): string {
  const entry = path.join(PROJECT_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  if (!existsSync(entry)) throw new Error(`Prisma CLI 不存在：${entry}`);
  return entry;
}

function runPrisma(args: string[]): string {
  return execFileSync(process.execPath, [prismaEntry(), ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: COMMAND_TIMEOUT_MS,
    env: { ...process.env, DATABASE_URL },
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
});
