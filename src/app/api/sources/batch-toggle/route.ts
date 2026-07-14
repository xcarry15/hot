import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { batchToggleSources } from '@/lib/source-actions';
import { runExclusiveMutation } from '@/lib/mutation-guard';

export async function POST(request: Request) {
  try {
    const result = await runExclusiveMutation('批量切换数据源', async () =>
      batchToggleSources(await request.json()),
    );
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result);
  } catch (error: unknown) {
    return apiError(error, 'Failed to batch toggle sources');
  }
}
