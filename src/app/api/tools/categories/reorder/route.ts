import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { formatToolSchemaError, toolCategoryReorderSchema } from '@/lib/tool-directory-schema';
import { moveToolDirectoryCategory } from '@/lib/tool-directory-service';
import type { ToolDirectoryCategoryId } from '@/contracts/tool-directory';

export async function POST(request: Request) {
  try {
    const parsed = toolCategoryReorderSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: formatToolSchemaError(parsed.error) }, { status: 400 });
    }
    const category = await runExclusiveMutation('调整工具分类排序', () => (
      moveToolDirectoryCategory(parsed.data.id as ToolDirectoryCategoryId, parsed.data.direction)
    ));
    return NextResponse.json(category);
  } catch (error: unknown) {
    return apiError(error, '调整工具分类排序失败');
  }
}
