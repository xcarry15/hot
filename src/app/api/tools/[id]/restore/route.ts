import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { restoreToolDirectoryItem } from '@/lib/tool-directory-service';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const item = await runExclusiveMutation('恢复工具', () => restoreToolDirectoryItem(id));
    return NextResponse.json(item);
  } catch (error: unknown) {
    return apiError(error, '恢复工具失败');
  }
}
