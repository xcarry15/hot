import { requireAdminAuth } from '@/lib/require-admin-auth';
import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { formatToolSchemaError, toolReorderSchema } from '@/lib/tool-directory-schema';
import { moveToolDirectoryItem } from '@/lib/tool-directory-service';

export async function POST(request: Request) {
  const denied = request ? requireAdminAuth(request as NextRequest) : null;
  if (denied) return denied;
  try {
    const parsed = toolReorderSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: formatToolSchemaError(parsed.error) }, { status: 400 });
    }
    const item = await runExclusiveMutation('调整工具排序', () => moveToolDirectoryItem(parsed.data.id, parsed.data.direction));
    return NextResponse.json(item);
  } catch (error: unknown) {
    return apiError(error, '调整工具排序失败');
  }
}
