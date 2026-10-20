import { NextResponse } from 'next/server';
import { getAIProviderUnavailableReason } from '@/contracts/ai-provider';

/** 保留停用响应，避免旧页面继续把上游免费目录误认为可调用候选。 */
export async function GET() {
  return NextResponse.json({
    models: [],
    error: getAIProviderUnavailableReason('opencode'),
  }, {
    status: 410,
    headers: { 'Cache-Control': 'no-store' },
  });
}
