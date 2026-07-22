import { NextResponse } from 'next/server';

const OPENCODE_MODELS_URL = 'https://opencode.ai/zen/v1/models';

interface OpenCodeModel {
  id?: unknown;
  free?: unknown;
  isFree?: unknown;
  pricing?: unknown;
}

interface OpenCodeModelsResponse {
  data?: unknown;
}

function isZeroPrice(value: unknown): boolean {
  return value === 0 || value === '0' || value === '0.0' || value === '0.00';
}

function hasZeroPricing(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prices = Object.values(value as Record<string, unknown>);
  return prices.length > 0 && prices.every(isZeroPrice);
}

function isFreeModel(model: OpenCodeModel): boolean {
  if (model.free === true || model.isFree === true || hasZeroPricing(model.pricing)) return true;
  return model.id === 'big-pickle' || (typeof model.id === 'string' && model.id.endsWith('-free'));
}

function getFreeModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const data = (payload as OpenCodeModelsResponse).data;
  if (!Array.isArray(data)) return [];

  const ids = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const model = item as OpenCodeModel;
    if (!isFreeModel(model) || typeof model.id !== 'string' || !model.id.trim()) continue;
    ids.add(model.id.trim());
  }
  return [...ids];
}

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const response = await fetch(OPENCODE_MODELS_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return NextResponse.json({ error: `OpenCode 模型列表请求失败（${response.status}）` }, { status: 502 });
    }

    const models = getFreeModelIds(await response.json());
    return NextResponse.json({ models }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'OpenCode 模型列表暂时不可用' }, { status: 502 });
  }
}
