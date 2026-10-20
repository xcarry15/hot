import { NextResponse } from 'next/server';
import { providerSettingKey } from '@/contracts/ai-provider';
import { fetchSafe, readResponseText } from '@/lib/http';
import { getSetting } from '@/lib/settings';
import { withTimeout } from '@/lib/shared/async';

const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models';
const MAX_MODEL_CATALOG_BYTES = 512 * 1024;

interface DeepSeekModel {
  id?: unknown;
  owned_by?: unknown;
  output_modalities?: unknown;
}

interface DeepSeekModelsResponse {
  data?: unknown;
}

function getDeepSeekModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const data = (payload as DeepSeekModelsResponse).data;
  if (!Array.isArray(data)) return [];

  const ids = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const model = item as DeepSeekModel;
    const id = typeof model.id === 'string' ? model.id.trim() : '';
    if (!id || id.length > 128 || /\s/.test(id)) continue;
    if (typeof model.owned_by === 'string' && model.owned_by !== 'deepseek') continue;
    if (Array.isArray(model.output_modalities) && !model.output_modalities.includes('text')) continue;
    ids.add(id);
  }
  return [...ids];
}

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const apiKey = await getSetting(providerSettingKey('deepseek', 'api_key'));
    if (!apiKey.trim()) {
      return NextResponse.json({ error: '请先保存 DeepSeek API Key' }, { status: 400 });
    }

    const response = await withTimeout(
      (signal) => fetchSafe(DEEPSEEK_MODELS_URL, {
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal,
      }),
      10_000,
      'DeepSeek 模型列表请求超时',
    );
    if (!response.ok) {
      return NextResponse.json({ error: `DeepSeek 模型列表请求失败（${response.status}）` }, { status: 502 });
    }

    const payload: unknown = JSON.parse(await readResponseText(response, MAX_MODEL_CATALOG_BYTES));
    const models = getDeepSeekModelIds(payload);
    if (models.length === 0) {
      return NextResponse.json({ error: 'DeepSeek 官方模型列表为空或格式无效' }, { status: 502 });
    }

    return NextResponse.json({ models }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'DeepSeek 模型列表暂时不可用' }, { status: 502 });
  }
}
