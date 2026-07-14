import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { createSource, listSources } from '@/lib/source-actions';
import { runExclusiveMutation } from '@/lib/mutation-guard';

// GET /api/sources - List all sources
export async function GET() {
  try {
    return NextResponse.json(await listSources());
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch sources');
  }
}

// POST /api/sources - Create a new source
export async function POST(request: Request) {
  try {
    const result = await runExclusiveMutation('创建数据源', async () =>
      createSource(await request.json().catch(() => ({}))),
    );
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result.source, { status: result.status });
  } catch (error: unknown) {
    return apiError(error, 'Failed to create source');
  }
}
