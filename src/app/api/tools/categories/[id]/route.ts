import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { formatToolSchemaError, toolCategoryUpdateSchema } from '@/lib/tool-directory-schema';
import { updateToolDirectoryCategory } from '@/lib/tool-directory-service';
import type { ToolDirectoryCategoryId } from '@/contracts/tool-directory';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const parsed = toolCategoryUpdateSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: formatToolSchemaError(parsed.error) }, { status: 400 });
    }
    const category = await runExclusiveMutation('编辑工具分类', () => (
      updateToolDirectoryCategory(id as ToolDirectoryCategoryId, parsed.data)
    ));
    return NextResponse.json(category);
  } catch (error: unknown) {
    return apiError(error, '编辑工具分类失败');
  }
}
