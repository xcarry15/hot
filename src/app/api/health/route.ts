import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '@/lib/db';

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
    return NextResponse.json(
      { ok: true, revision },
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
