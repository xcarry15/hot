import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '@/lib/db';
import { assertSettingsCryptoHealthy } from '@/lib/settings-service';

export const dynamic = 'force-dynamic';

async function readReleaseRevision(): Promise<string | null> {
  try {
    const revision = (await readFile(path.join(process.cwd(), '.release-revision'), 'utf8')).trim();
    return /^[0-9a-f]{40}$/i.test(revision) ? revision : null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const [, revision] = await Promise.all([
      db.setting.findFirst({ select: { id: true } }),
      readReleaseRevision(),
    ]);
    // 自检失败只在响应体标记并写日志；状态码保持 200，避免 Nginx / 监控误杀。
    // 仅生产环境执行：测试与本地开发不依赖真实密钥，也不改变既有响应契约。
    let cryptoHealthFlag: { settingsCryptoHealthy: false } | undefined;
    if (process.env.NODE_ENV === 'production') {
      try {
        await assertSettingsCryptoHealthy();
      } catch (error) {
        cryptoHealthFlag = { settingsCryptoHealthy: false };
        console.error('[health] settings crypto self-check failed:', error);
      }
    }
    return NextResponse.json(
      { ok: true, revision, ...cryptoHealthFlag },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[health] database readiness check failed:', error);
    return NextResponse.json(
      { ok: false },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

export const HEAD = GET;
