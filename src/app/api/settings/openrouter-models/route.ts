import { NextResponse } from 'next/server';
import { AI_PROVIDERS } from '@/contracts/ai-provider';
import { fetchSafe, readResponseText } from '@/lib/http';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=text&max_price=0&max_output_price=0&sort=most-popular';

interface OpenRouterModel {
  id?: unknown;
  pricing?: unknown;
}

interface OpenRouterModelsResponse {
  data?: unknown;
}

function isZeroPrice(value: unknown): boolean {
  if (value === 0) return true;
  return typeof value === 'string' && value.trim() !== '' && Number(value) === 0;
}

function hasZeroPricing(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prices = Object.values(value as Record<string, unknown>);
  return prices.length > 0 && prices.every(isZeroPrice);
}

function getFreeModelIds(payload: unknown): string[] {
  const ids = new Set<string>(AI_PROVIDERS.openrouter.models);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [...ids];

  const data = (payload as OpenRouterModelsResponse).data;
  if (!Array.isArray(data)) return [...ids];

  ids.clear();
  ids.add(AI_PROVIDERS.openrouter.defaultModel);
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const model = item as OpenRouterModel;
    const id = typeof model.id === 'string' ? model.id.trim() : '';
    // OpenRouter 官方用 :free 变体标识可直接指定的免费模型；过滤掉同样 0 价但不是
    // 文本聊天模型的特殊条目，确保这些模型会走免费请求闸门。
    if (!id || !id.endsWith(':free') || !hasZeroPricing(model.pricing)) continue;
    ids.add(id);
  }
  return [...ids];
}

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const response = await fetchSafe(OPENROUTER_MODELS_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return NextResponse.json({ error: `OpenRouter 模型列表请求失败（${response.status}）` }, { status: 502 });
    }

    const models = getFreeModelIds(JSON.parse(await readResponseText(response)));
    return NextResponse.json({ models }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'OpenRouter 模型列表暂时不可用' }, { status: 502 });
  }
}
