/**
 * API Route 公共工具 —— 消除 27 个路由文件中重复的 try/catch 样板。
 *
 * 用法：catch (e) { return apiError(e, '操作失败'); }
 */

import { NextResponse } from 'next/server';
import { MutationConflictError } from '@/lib/mutation-guard';

/** 将 catch 到的 unknown error 统一包装为 JSON 响应 */
export function apiError(error: unknown, fallback: string, status = 500): NextResponse {
  if (error instanceof MutationConflictError || isExposedApiError(error)) {
    const errorStatus = isSafeStatus(error.status) ? error.status : status;
    return NextResponse.json({ error: error.message }, { status: errorStatus });
  }
  // 不把 Prisma、上游服务、文件路径或配置内容回显给浏览器；详细信息只留在
  // 服务端日志中，避免异常响应成为内部实现和凭据的旁路泄露。
  console.error(`[api] ${fallback}:`, error);
  return NextResponse.json({ error: fallback }, { status });
}

function isExposedApiError(error: unknown): error is Error & { exposeToClient: true; status?: unknown } {
  return error instanceof Error && (error as { exposeToClient?: unknown }).exposeToClient === true;
}

function isSafeStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value < 500;
}
