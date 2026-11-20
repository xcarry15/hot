import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { requireAdminAuth } from '@/lib/require-admin-auth';
import { MAX_SMALL_JSON_BODY_BYTES, readLimitedJson } from '@/lib/request-body';
import { updateTechnicalIgnoreState } from '@/lib/technical-work-queue-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  // 路由层显式鉴权：proxy.ts 之外再校验一次，避免只靠 matcher 单点防护。
  const denied = requireAdminAuth(request);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    const body = await readLimitedJson(request, MAX_SMALL_JSON_BODY_BYTES, '请求正文过大');
    const rawAction = typeof body === 'object' && body !== null && 'action' in body
      ? (body as { action?: unknown }).action
      : undefined;
    const action = rawAction === 'ignore' ? 'ignore' : rawAction === 'restore' ? 'restore' : null;
    if (!action) return NextResponse.json({ error: 'action 无效' }, { status: 400 });
    // technicalIgnoredAt 是 collect/process/analyze/cluster 的 pendingWhere 门控，
    // 也门控推送、AI 队列、统计与代表文章跳过。Job 运行期间由 runJob 占用
    // mutation reservation，这里必须同样参与，否则可在 Job 中途改变数据集边界。
    const updated = await runExclusiveMutation('更新技术异常状态', () => updateTechnicalIgnoreState(id, action));
    if (!updated) return NextResponse.json({ error: '文章不存在' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, '更新技术异常状态失败');
  }
}
