import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import {
  createToolDirectoryItem,
  listToolDirectory,
} from '@/lib/tool-directory-service';
import {
  formatToolSchemaError,
  toolCreateSchema,
} from '@/lib/tool-directory-schema';

export async function GET(request: Request) {
  try {
    const includeArchived = new URL(request.url).searchParams.get('includeArchived') === '1';
    return NextResponse.json(await listToolDirectory(includeArchived));
  } catch (error: unknown) {
    return apiError(error, '获取工具目录失败');
  }
}

export async function POST(request: Request) {
  try {
    const parsed = toolCreateSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: formatToolSchemaError(parsed.error) }, { status: 400 });
    }
    const item = await runExclusiveMutation('新增工具', () => createToolDirectoryItem(parsed.data));
    return NextResponse.json(item, { status: 201 });
  } catch (error: unknown) {
    return apiError(error, '新增工具失败');
  }
}
