import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEPLOY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'deploy-production.sh');
const TEST_TMP = mkdtempSync(path.join(tmpdir(), 'hot2-deploy-test-'));
const FAKE_BIN = path.join(TEST_TMP, 'bin');
const APP_DIR = path.join(TEST_TMP, 'app');
const BACKUP_ROOT = path.join(TEST_TMP, 'backups');
const LOG_PATH = path.join(TEST_TMP, 'commands.log');
const ARCHIVE_PATH = path.join(TEST_TMP, 'release.tgz');

function bashPath(value: string): string {
  if (process.platform !== 'win32') return value;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  if (!match) return value.replaceAll('\\', '/');
  return '/' + match[1].toLowerCase() + '/' + match[2].replaceAll('\\', '/');
}

function normalizedPath(value: string): string {
  return path.normalize(value.replaceAll('/', path.sep));
}

function writeExecutable(name: string, content: string): void {
  const filePath = path.join(FAKE_BIN, name);
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function createFakeCommands(): void {
  mkdirSync(FAKE_BIN, { recursive: true });
  writeExecutable('node', '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable('npm', `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "\${FAKE_LOG}"
if [[ "$*" == "run build" ]]; then mkdir -p .next; fi
exit 0
`);
  writeExecutable('pm2', `#!/usr/bin/env bash
set -euo pipefail
printf 'pm2 %s\\n' "$*" >> "\${FAKE_LOG}"
case "\${1:-}" in
  describe) exit 0 ;;
  *) exit 0 ;;
esac
`);
  writeExecutable('sqlite3', `#!/usr/bin/env bash
set -euo pipefail
database="$1"
shift || true
joined="$*"
if [[ "$joined" == *".backup"* ]]; then
  target="\${joined#*.backup }"
  target="\${target//\\'/}"
  mkdir -p "$(dirname "$target")"
  cp "$database" "$target"
  exit 0
fi
if [[ "$joined" == *"sqlite_master"* ]]; then
  echo 1
elif [[ "$joined" == *"NOT IN"* ]]; then
  echo 0
elif [[ "$joined" == *"migration_name ="* ]]; then
  echo 1
else
  echo 0
fi
`);
  writeExecutable('curl', `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAKE_CURL_FAIL:-0}" == "1" ]]; then exit 22; fi
url="\${!#}"
if [[ "$url" == */ ]]; then
  printf '<link href="/_next/static/app.css" rel="stylesheet">'
fi
`);
}

function createReleaseArchive(): void {
  const source = path.join(TEST_TMP, 'release-source');
  rmSync(source, { recursive: true, force: true });
  mkdirSync(path.join(source, 'prisma', 'migrations', '20260731120000_current_schema_baseline'), { recursive: true });
  writeFileSync(path.join(source, 'package.json'), '{}');
  writeFileSync(path.join(source, 'package-lock.json'), '{}');
  writeFileSync(
    path.join(source, 'prisma', 'migrations', '20260731120000_current_schema_baseline', 'migration.sql'),
    '-- test migration',
  );
  rmSync(ARCHIVE_PATH, { force: true });
  execFileSync('tar', ['-czf', ARCHIVE_PATH, '-C', source.replace(/\\/g, '/'), '.']);
}

function runDeploy(releaseId: string, failHealth = false): void {
  const pathSeparator = ':';
  try {
    execFileSync('bash', [bashPath(DEPLOY_SCRIPT)], {
      cwd: PROJECT_ROOT,
      env: {
      ...process.env,
      PATH: `${bashPath(FAKE_BIN)}${pathSeparator}/usr/bin:/bin:${process.env.PATH ?? ''}`,
      APP_DIR: bashPath(APP_DIR),
      APP_NAME: 'h2-hot2-test',
      BACKUP_ROOT: bashPath(BACKUP_ROOT),
      CURRENT_LINK: bashPath(path.join(APP_DIR, 'current')),
      FAKE_LOG: bashPath(LOG_PATH),
      RELEASES_DIR: bashPath(path.join(APP_DIR, 'releases')),
      RELEASE_ARCHIVE: bashPath(ARCHIVE_PATH),
      RELEASE_ID: releaseId,
      RESET_PRODUCTION: 'NO',
      SHARED_DIR: bashPath(path.join(APP_DIR, 'shared')),
      SITE_URL: 'https://example.test',
        ...(failHealth ? { FAKE_CURL_FAIL: '1' } : { FAKE_CURL_FAIL: '0' }),
      },
      stdio: 'pipe',
    });
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error([
      'deploy script failed',
      failure.stdout?.toString('utf8') ?? '',
      failure.stderr?.toString('utf8') ?? '',
    ].join('\n'));
  }
}

afterAll(() => {
  rmSync(TEST_TMP, { recursive: true, force: true });
});

// 生产脚本运行在 GitHub Ubuntu/宝塔 Linux；Windows 本地没有可复用的 POSIX
// symlink + bash 运行时，因此只在 CI/Linux 执行这组脚本级集成测试。
const deployDescribe = process.platform === 'win32' ? describe.skip : describe;

deployDescribe('production release deployment', () => {
  it('构建失败前不影响 current，成功后原子切换并保留共享状态', () => {
    createFakeCommands();
    mkdirSync(path.join(APP_DIR, 'db'), { recursive: true });
    writeFileSync(path.join(APP_DIR, '.env'), [
      'DATABASE_URL=file:../db/custom.db',
      'API_TOKEN=test-token',
      'SETTINGS_ENCRYPTION_KEY=test-key',
      'NEXT_PUBLIC_SITE_URL=https://example.test',
      '',
    ].join('\n'));
    writeFileSync(path.join(APP_DIR, 'db', 'custom.db'), 'before');

    createReleaseArchive();
    runDeploy('release-one');

    const currentLink = path.join(APP_DIR, 'current');
    const firstRelease = normalizedPath(readlinkSync(currentLink));
    expect(firstRelease).toBe(normalizedPath(path.join(APP_DIR, 'releases', 'release-one')));
    expect(existsSync(path.join(APP_DIR, 'shared', 'db', 'custom.db'))).toBe(true);
    expect(normalizedPath(readlinkSync(path.join(APP_DIR, 'db')))).toBe(
      normalizedPath(path.join(APP_DIR, 'shared', 'db')),
    );
    expect(readFileSync(LOG_PATH, 'utf8')).toContain('npm run build');
    expect(existsSync(path.join(APP_DIR, 'releases', 'release-one', '.next'))).toBe(true);
  });

  it('健康检查失败时恢复数据库备份和旧 current', () => {
    createReleaseArchive();
    expect(() => runDeploy('release-two', true)).toThrow();

    const currentLink = path.join(APP_DIR, 'current');
    expect(normalizedPath(readlinkSync(currentLink))).toBe(
      normalizedPath(path.join(APP_DIR, 'releases', 'release-one')),
    );
    expect(existsSync(path.join(APP_DIR, 'releases', 'release-two'))).toBe(false);
    expect(readFileSync(path.join(APP_DIR, 'shared', 'db', 'custom.db'), 'utf8')).toBe('before');
  });
});
