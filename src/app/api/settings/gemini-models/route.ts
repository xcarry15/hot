import { NextResponse } from 'next/server';
import { providerSettingKey } from '@/contracts/ai-provider';
import { fetchGeminiModelIds, GeminiModelsError } from '@/lib/gemini-provider';
import { getSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const apiKey = (await getSetting(providerSettingKey('gemini', 'api_key'))).trim();
    if (!apiKey) return NextResponse.json({ error: '请先保存 Gemini API Key' }, { status: 400 });
    const models = await fetchGeminiModelIds(apiKey);
    return NextResponse.json({ models }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof GeminiModelsError ? error.message : 'Gemini 模型列表暂时不可用，已保留当前候选',
    }, { status: 502 });
  }
}
