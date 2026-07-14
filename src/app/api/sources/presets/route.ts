import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { addPresetSources, listPresetSources } from '@/lib/source-actions';
import { runExclusiveMutation } from '@/lib/mutation-guard';

export async function GET() {
  try {
    return NextResponse.json(await listPresetSources());
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch preset sources');
  }
}

export async function POST(request: Request) {
  try {
    const result = await runExclusiveMutation('添加预设数据源', async () =>
      addPresetSources(await request.json()),
    );
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result);
  } catch (error: unknown) {
    return apiError(error, 'Failed to add preset sources');
  }
}
