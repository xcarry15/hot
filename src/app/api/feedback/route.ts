import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { applyTuningSuggestion, dismissTuningSuggestion, generateTuningSuggestions, listTuningSuggestions } from '@/lib/review-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';

export async function GET() {
  try {
    try {
      await runExclusiveMutation('生成反馈建议', generateTuningSuggestions);
    } catch {
      // 抓取/分析任务占用写入门禁时，仍返回已有建议，不影响概览读取。
    }
    return NextResponse.json(await listTuningSuggestions());
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch feedback suggestions');
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id || (body.action !== 'apply' && body.action !== 'dismiss')) return NextResponse.json({ error: '参数无效' }, { status: 400 });
    const result = body.action === 'apply'
      ? await runExclusiveMutation('处理调优建议', () => applyTuningSuggestion(id))
      : await runExclusiveMutation('处理调优建议', () => dismissTuningSuggestion(id));
    if (!result) return NextResponse.json({ error: '建议不存在或已处理' }, { status: 404 });
    return NextResponse.json(result);
  } catch (error: unknown) {
    return apiError(error, 'Failed to update feedback suggestion');
  }
}
