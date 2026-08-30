import { NextResponse } from 'next/server';
import { proxyUrlSchema } from '@/contracts/proxy';
import { apiError } from '@/lib/api-helpers';
import { testOutboundProxies, testOutboundProxy } from '@/lib/proxy-test-service';

// POST /api/settings/test-proxy - Test the global outbound proxy against Winshang.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.action === 'all') {
      return NextResponse.json(await testOutboundProxies(body?.refresh === true));
    }
    const parsed = proxyUrlSchema.safeParse(body?.proxyUrl);
    if (!parsed.success || !parsed.data) {
      return NextResponse.json({
        success: false,
        error: parsed.success ? '请先填写代理地址' : parsed.error.issues[0]?.message || '代理地址无效',
      }, { status: 400 });
    }
    return NextResponse.json(await testOutboundProxy(parsed.data));
  } catch (error: unknown) {
    return apiError(error, '代理连通性测试失败');
  }
}
