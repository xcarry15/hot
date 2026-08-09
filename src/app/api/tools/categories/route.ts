import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { listToolDirectoryCategories } from '@/lib/tool-directory-service';

export async function GET() {
  try {
    return NextResponse.json(await listToolDirectoryCategories());
  } catch (error: unknown) {
    return apiError(error, '获取工具分类失败');
  }
}
