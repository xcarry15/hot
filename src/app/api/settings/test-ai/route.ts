import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { testAIConnection } from '@/lib/ai-client';
import { AI_PROVIDERS } from '@/contracts/ai-provider';
import { z } from 'zod';

const schema = z.object({
  provider: z.enum(Object.keys(AI_PROVIDERS) as [keyof typeof AI_PROVIDERS, ...(keyof typeof AI_PROVIDERS)[]]),
  apiKey: z.string(),
  baseUrl: z.string().url('API 地址格式不正确'),
  model: z.string().min(1, '模型名称不能为空'),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(1).max(65536),
});

export async function POST(request: Request) {
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
    const result = await testAIConnection(parsed.data);
    return NextResponse.json(result);
  } catch (error: unknown) {
    return apiError(error, 'AI connection test failed');
  }
}
