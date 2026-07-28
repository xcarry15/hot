import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getSettings, updateSettings } from '@/lib/settings-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { runJob } from '@/lib/execution';
import { previewPushDelivery, previewPublicPublication, previewScorePolicy } from '@/lib/score-policy-service';
import { z } from 'zod';

// 保持旧的 reveal 路由导入路径兼容；实际清单来自统一配置目录。
export { SENSITIVE_SETTING_KEYS } from '@/lib/settings';

// GET /api/settings - Get all settings (sensitive keys are redacted)
export async function GET() {
  try {
    return NextResponse.json(await getSettings());
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch settings');
  }
}

// PUT /api/settings - Update settings
export async function PUT(request: Request) {
  try {
    const result = await runExclusiveMutation('更新设置', async () => updateSettings(await request.json()));
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, details: result.details },
        { status: 400 }
      );
    }

    // 设置事务已经完成；后台重算的即时唤醒失败不能反向把“保存成功”报成失败。
    // 标记保留在 Setting 中，调度器会在下一次 tick 自动续跑。
    let rebuildJobQueued = false;
    let rebuildDeferred = false;
    if (result.rebuildQueued) {
      try {
        const rebuildJob = await runJob('full', {
          trigger: 'settings-rebuild',
          skipCollect: true,
          settingsRebuild: true,
        });
        rebuildJobQueued = rebuildJob.queued;
        rebuildDeferred = !rebuildJobQueued;
      } catch (error) {
        rebuildDeferred = true;
        console.error('[settings] rebuild wake-up failed; scheduler will retry:', error);
      }
    }
    return NextResponse.json({
      ...result,
      rebuildJobQueued,
      rebuildDeferred,
    });
  } catch (error: unknown) {
    return apiError(error, 'Failed to update settings');
  }
}

const previewSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('score-preview'), weightEvent: z.number().int().min(0).max(100), weightContent: z.number().int().min(0).max(100), keywordBonus: z.number().int().min(0).max(20) }).refine(value => value.weightEvent + value.weightContent === 100, '评分权重合计必须为 100'),
  z.object({ action: z.literal('public-preview'), minScore: z.number().int().min(0).max(100), minRelevance: z.number().int().min(0).max(100), hideAds: z.boolean() }),
  z.object({ action: z.literal('push-preview'), minScore: z.number().int().min(0).max(100), minRelevance: z.number().int().min(0).max(100), pushMode: z.string() }),
]);

// POST /api/settings - 设置相关的只读预演操作
export async function POST(request: Request) {
  try {
    const parsed = previewSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    if (parsed.data.action === 'score-preview') return NextResponse.json(await previewScorePolicy(parsed.data.weightEvent, parsed.data.weightContent, parsed.data.keywordBonus));
    if (parsed.data.action === 'public-preview') return NextResponse.json(await previewPublicPublication(parsed.data.minScore, parsed.data.minRelevance, parsed.data.hideAds));
    return NextResponse.json(await previewPushDelivery(parsed.data.minScore, parsed.data.minRelevance, parsed.data.pushMode));
  } catch (error: unknown) {
    return apiError(error, '评分策略预演失败');
  }
}
