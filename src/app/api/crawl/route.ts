import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runJob } from '@/lib/execution';
import { readPushSettings } from '@/lib/push/policy';

type CrawlStage = 'collect' | 'process' | 'ai' | 'push' | 'all';

// POST /api/crawl - Trigger a single source or a pipeline stage
//   { sourceId }                          → collect that source only (async)
//   { stage: 'collect' }                  → run collect job (async)
//   { stage: 'process' }                  → run process job (async)
//   { stage: 'ai' }                       → run ai job (async)
//   { stage: 'push' }                     → run push job (async)
//   { stage: 'all' } (default)            → run full pipeline job (async)
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim() : undefined;
    const stage = typeof body.stage === 'string' ? body.stage : 'all';
    const validStages: readonly CrawlStage[] = ['all', 'collect', 'process', 'ai', 'push'];

    if ('sourceId' in body && !sourceId) {
      return NextResponse.json({ error: 'sourceId 必须是非空字符串' }, { status: 400 });
    }
    if (!validStages.includes(stage as CrawlStage)) {
      return NextResponse.json({ error: 'Unknown crawl stage' }, { status: 400 });
    }
    if (stage === 'push' && (await readPushSettings()).pushMode === 'off') {
      return NextResponse.json({ error: '当前推送模式已关闭，请先在设置中启用推送' }, { status: 409 });
    }

    const stageJobType: Record<CrawlStage, 'full' | 'collect' | 'process' | 'ai' | 'push'> = {
      all: 'full',
      collect: 'collect',
      process: 'process',
      ai: 'ai',
      push: 'push',
    };
    // 单源请求的语义始终是 collect；不能因客户端额外带了 stage 而意外跑完整流水线。
    const jobType = sourceId ? 'collect' : stageJobType[stage as CrawlStage];

    // 手动触发（API / 前端按钮）：直接调用 runJob，不经 scheduler 的
    // crawl_interval_min 间隔检查（重构 #3 全局唯一调度策略）。
    const res = await runJob(jobType, sourceId ? { sourceId, trigger: 'manual' } : { trigger: 'manual' });
    if (!res.queued) {
      return NextResponse.json({ queued: false, reason: res.reason });
    }
    return NextResponse.json({ queued: true, jobId: res.jobId });
  } catch (error: unknown) {
    return apiError(error, 'Crawl failed');
  }
}
