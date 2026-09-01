import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError } from '@/lib/api-helpers';
import { testSavedAIModel } from '@/lib/ai-client';

const schema = z.object({
  provider: z.enum(['opencode', 'openrouter']),
  model: z.string().trim().min(1, '模型名称不能为空').max(200, '模型名称过长'),
});

/** POST /api/settings/test-ai-model - 测试一个已保存配置下的免费模型。 */
export async function POST(request: Request) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || '模型配置无效' }, { status: 400 });
    }

    return NextResponse.json(await testSavedAIModel(parsed.data.provider, parsed.data.model));
  } catch (error: unknown) {
    return apiError(error, 'AI 模型可用性测试失败');
  }
}
