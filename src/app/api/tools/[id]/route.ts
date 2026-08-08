import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import {
  archiveToolDirectoryItem,
  updateToolDirectoryItem,
} from '@/lib/tool-directory-service';
import { formatToolSchemaError, toolUpdateSchema } from '@/lib/tool-directory-schema';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const parsed = toolUpdateSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: formatToolSchemaError(parsed.error) }, { status: 400 });
    }
    const item = await runExclusiveMutation('编辑工具', () => updateToolDirectoryItem(id, parsed.data));
    return NextResponse.json(item);
  } catch (error: unknown) {
    return apiError(error, '编辑工具失败');
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const item = await runExclusiveMutation('下架工具', () => archiveToolDirectoryItem(id));
    return NextResponse.json(item);
  } catch (error: unknown) {
    return apiError(error, '下架工具失败');
  }
}
