import { requireAdminAuth } from '@/lib/require-admin-auth';
import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { createPromptVersion, deletePromptVersion, listPromptVersions } from '@/lib/prompt-version-service';

export async function GET(request?: Request) {
  const denied = request ? requireAdminAuth(request as NextRequest) : null;
  if (denied) return denied;
  try {
    return NextResponse.json({ versions: await listPromptVersions() });
  } catch (error: unknown) {
    return apiError(error, '获取提示词版本失败');
  }
}

export async function POST(request: Request) {
  const denied = request ? requireAdminAuth(request as NextRequest) : null;
  if (denied) return denied;
  try {
    const input: unknown = await request.json();
    const version = await runExclusiveMutation('保存提示词版本', () => createPromptVersion(input));
    return NextResponse.json({ version }, { status: 201 });
  } catch (error: unknown) {
    return apiError(error, '保存提示词版本失败');
  }
}

export async function DELETE(request: Request) {
  const denied = request ? requireAdminAuth(request as NextRequest) : null;
  if (denied) return denied;
  try {
    const body: unknown = await request.json().catch(() => null);
    const id = body && typeof body === 'object' && 'id' in body && typeof body.id === 'string'
      ? body.id
      : '';
    if (!id) return NextResponse.json({ error: '提示词版本 id 为必填项' }, { status: 400 });
    const deleted = await runExclusiveMutation('删除提示词版本', () => deletePromptVersion(id));
    if (!deleted) return NextResponse.json({ error: '提示词版本不存在' }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (error: unknown) {
    return apiError(error, '删除提示词版本失败');
  }
}
