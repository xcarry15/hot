import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { formatToolSchemaError, toolCategoryCreateSchema } from '@/lib/tool-directory-schema';
import { createToolDirectoryCategory, listToolDirectoryCategories } from '@/lib/tool-directory-service';

export async function GET() {
  try {
    return NextResponse.json(await listToolDirectoryCategories());
  } catch (error: unknown) {
    return apiError(error, '获取工具分类失败');
  }
}

export async function POST(request: Request) {
  try {
    const parsed = toolCategoryCreateSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: formatToolSchemaError(parsed.error) }, { status: 400 });
    }
    const category = await runExclusiveMutation('新增工具分类', () => (
      createToolDirectoryCategory(parsed.data)
    ));
    return NextResponse.json(category, { status: 201 });
  } catch (error: unknown) {
    return apiError(error, '新增工具分类失败');
  }
}
