/**
 * API Route 公共工具 —— 消除 27 个路由文件中重复的 try/catch 样板。
 *
 * 用法：catch (e) { return apiError(e, '操作失败'); }
 */

import { NextResponse } from 'next/server';
import { MutationConflictError } from '@/lib/mutation-guard';

/** 将 catch 到的 unknown error 统一包装为 JSON 响应 */
export function apiError(error: unknown, fallback: string, status = 500): NextResponse {
  if (error instanceof MutationConflictError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  const msg = error instanceof Error ? error.message : fallback;
  return NextResponse.json({ error: msg }, { status });
}
