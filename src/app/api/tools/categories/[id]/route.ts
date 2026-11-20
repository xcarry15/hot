import { requireAdminAuth } from '@/lib/require-admin-auth';
import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { formatToolSchemaError, toolCategoryUpdateSchema } from '@/lib/tool-directory-schema';
import { deleteToolDirectoryCategory, updateToolDirectoryCategory } from '@/lib/tool-directory-service';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = request ? requireAdminAuth(request as NextRequest) : null;
  if (denied) return denied;
  try {
    const { id } = await params;
    const parsed = toolCategoryUpdateSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: formatToolSchemaError(parsed.error) }, { status: 400 });
    }
    const category = await runExclusiveMutation('编辑工具分类', () => (
      updateToolDirectoryCategory(id, parsed.data)
    ));
    return NextResponse.json(category);
  } catch (error: unknown) {
    return apiError(error, '编辑工具分类失败');
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = request ? requireAdminAuth(request as NextRequest) : null;
  if (denied) return denied;
  try {
    const { id } = await params;
    const category = await runExclusiveMutation('删除工具分类', () => deleteToolDirectoryCategory(id));
    return NextResponse.json(category);
  } catch (error: unknown) {
    return apiError(error, '删除工具分类失败');
  }
}
