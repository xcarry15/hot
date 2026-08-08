import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cleanupExpiredSendingDeliveries: vi.fn(),
  exportJobFindMany: vi.fn(),
  resetOrphanedJobs: vi.fn(),
  resumeQueuedJob: vi.fn(),
  runJob: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  readAllSettings: vi.fn(),
  hasDueTechnicalRecovery: vi.fn(),
  hasDirtyEvents: vi.fn(),
  hasPendingSettingsRebuild: vi.fn(),
  jobFindUnique: vi.fn(),
  jobFindFirst: vi.fn(),
  eventFindFirst: vi.fn(),
  pushableWhere: vi.fn(),
  readPushSettings: vi.fn(),
}));

vi.mock('@/lib/execution', () => ({
  runJob: mocks.runJob,
  resetOrphanedJobs: mocks.resetOrphanedJobs,
  resumeQueuedJob: mocks.resumeQueuedJob,
}));

vi.mock('@/lib/settings', () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
  readAllSettings: mocks.readAllSettings,
  SETTING_KEYS: {
    AUTO_CRAWL_ENABLED: 'auto_crawl_enabled',
    CRAWL_INTERVAL_MIN: 'crawl_interval_min',
    CRAWL_QUIET_START: 'crawl_quiet_start',
    CRAWL_QUIET_END: 'crawl_quiet_end',
    SCHEDULER_LAST_CRAWL_AT: 'scheduler_last_crawl_at',
    SCHEDULER_LAST_PUSH_DATE: 'scheduler_last_push_date',
    SCHEDULER_PUSH_JOB: 'scheduler_push_job',
    PUSH_MODE: 'push_mode',
    PUSH_TIME: 'push_time',
  },
}));

vi.mock('@/lib/push/delivery', () => ({
  cleanupExpiredSendingDeliveries: mocks.cleanupExpiredSendingDeliveries,
}));

vi.mock('@/lib/db', () => ({
  db: {
    job: { findUnique: mocks.jobFindUnique, findFirst: mocks.jobFindFirst },
    event: { findFirst: mocks.eventFindFirst },
    exportJob: { findMany: mocks.exportJobFindMany },
  },
}));

vi.mock('@/lib/push/policy', () => ({
  pushableWhere: mocks.pushableWhere,
  readPushSettings: mocks.readPushSettings,
}));

vi.mock('@/lib/technical-work-queue-service', () => ({
  hasDueTechnicalRecovery: mocks.hasDueTechnicalRecovery,
}));

vi.mock('@/lib/event/event-consistency-service', () => ({
  hasDirtyEvents: mocks.hasDirtyEvents,
}));

vi.mock('@/lib/settings-rebuild-service', () => ({
  hasPendingSettingsRebuild: mocks.hasPendingSettingsRebuild,
}));

vi.mock('node-cron', () => ({
  default: { schedule: vi.fn(), validate: vi.fn(() => true) },
}));

import { runSchedulerTick } from '@/lib/scheduler';

describe('scheduler maintenance', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cleanupExpiredSendingDeliveries.mockResolvedValue(0);
    mocks.exportJobFindMany.mockResolvedValue([]);
    mocks.resetOrphanedJobs.mockResolvedValue(0);
    mocks.resumeQueuedJob.mockResolvedValue(null);
    mocks.readAllSettings.mockResolvedValue({
      auto_crawl_enabled: 'false',
      push_mode: 'off',
    });
    mocks.hasDueTechnicalRecovery.mockResolvedValue(false);
    mocks.hasDirtyEvents.mockResolvedValue(false);
    mocks.hasPendingSettingsRebuild.mockResolvedValue(false);
    mocks.jobFindUnique.mockResolvedValue(null);
    mocks.jobFindFirst.mockResolvedValue(null);
    mocks.eventFindFirst.mockResolvedValue(null);
    mocks.pushableWhere.mockReturnValue({ pushedAt: null });
    mocks.readPushSettings.mockResolvedValue({ pushMode: 'batch', minScore: 75, minRelevance: 70 });
    mocks.getSetting.mockImplementation(async (key: string) => {
      if (key === 'scheduler_last_push_date') return '';
      if (key === 'scheduler_push_job') return '';
      return null;
    });
  });

  it('每个调度 tick 都收口过期 sending 投递，再执行正常调度检查', async () => {
    await runSchedulerTick();

    expect(mocks.resetOrphanedJobs).toHaveBeenCalledTimes(1);
    expect(mocks.resumeQueuedJob).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupExpiredSendingDeliveries).toHaveBeenCalledTimes(1);
    expect(mocks.readAllSettings).toHaveBeenCalledTimes(1);
    expect(mocks.runJob).not.toHaveBeenCalled();
  });

  it('配置时间点被占用时不写每日完成标记，后续 tick 可补偿', async () => {
    vi.setSystemTime(new Date('2026-08-05T02:00:00.000Z')); // Asia/Shanghai 10:00
    mocks.readAllSettings.mockResolvedValue({
      auto_crawl_enabled: 'false',
      push_mode: 'batch',
      push_time: '08:30',
    });
    mocks.runJob.mockResolvedValue({ queued: false, reason: 'full job already active' });

    const { maybeEnqueueBatchPush } = await import('@/lib/scheduler');
    await maybeEnqueueBatchPush({ push_mode: 'batch', push_time: '08:30' });

    expect(mocks.runJob).toHaveBeenCalledWith('push', expect.objectContaining({
      trigger: 'auto',
      idempotencyKey: 'daily-push:2026-08-05',
    }));
    expect(mocks.setSetting).not.toHaveBeenCalledWith('scheduler_last_push_date', expect.anything());
  });

  it('只在 Job succeeded 后写入每日完成标记，并能处理 6 小时重试', async () => {
    vi.setSystemTime(new Date('2026-08-05T10:00:00.000Z')); // Asia/Shanghai 18:00
    const values: Record<string, string> = {
      scheduler_last_push_date: '',
      scheduler_push_job: '',
    };
    mocks.getSetting.mockImplementation(async (key: string) => values[key] ?? null);
    mocks.setSetting.mockImplementation(async (key: string, value: string) => { values[key] = value; });
    mocks.runJob.mockResolvedValue({ queued: true, jobId: 'job-1' });

    const { maybeEnqueueBatchPush } = await import('@/lib/scheduler');
    await maybeEnqueueBatchPush({ push_mode: 'batch', push_time: '08:30' });
    expect(values.scheduler_last_push_date).toBe('');
    expect(values.scheduler_push_job).toContain('job-1');

    mocks.jobFindUnique.mockResolvedValue({ status: 'succeeded' });
    await maybeEnqueueBatchPush({ push_mode: 'batch', push_time: '08:30' });
    expect(values.scheduler_last_push_date).toBe('2026-08-05');
    expect(values.scheduler_push_job).toBe('');

    mocks.eventFindFirst.mockResolvedValue({ id: 'retry-event' });
    mocks.runJob.mockResolvedValue({ queued: true, jobId: 'job-2' });
    await maybeEnqueueBatchPush({ push_mode: 'batch', push_time: '08:30' });
    expect(mocks.runJob).toHaveBeenLastCalledWith('push', expect.objectContaining({
      trigger: 'auto_retry',
      idempotencyKey: expect.stringMatching(/^batch-push-retry:/),
    }));
  });

  it('免打扰时段不创建自动抓取或批量推送 Job', async () => {
    vi.setSystemTime(new Date('2026-08-04T14:00:00.000Z')); // Asia/Shanghai 22:00
    const { maybeEnqueueCrawl, maybeEnqueueBatchPush } = await import('@/lib/scheduler');

    await maybeEnqueueCrawl({
      auto_crawl_enabled: 'true',
      crawl_interval_min: '5',
      crawl_quiet_start: '22:00',
      crawl_quiet_end: '08:00',
    });
    await maybeEnqueueBatchPush({
      push_mode: 'batch',
      push_time: '08:30',
      crawl_quiet_start: '22:00',
      crawl_quiet_end: '08:00',
    });

    expect(mocks.runJob).not.toHaveBeenCalled();
  });

  it('批量推送时间落在免打扰时段时，在免打扰结束后顺延执行', async () => {
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z')); // Asia/Shanghai 08:00
    mocks.runJob.mockResolvedValue({ queued: true, jobId: 'deferred-push' });
    const { maybeEnqueueBatchPush } = await import('@/lib/scheduler');

    await maybeEnqueueBatchPush({
      push_mode: 'batch',
      push_time: '23:00',
      crawl_quiet_start: '22:00',
      crawl_quiet_end: '08:00',
    });

    expect(mocks.runJob).toHaveBeenCalledWith('push', expect.objectContaining({
      trigger: 'auto',
      idempotencyKey: 'daily-push:2026-08-05',
    }));
  });

  it('realtime 推送在免打扰期间被跳过后，会在时段结束补发', async () => {
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z')); // Asia/Shanghai 08:00
    mocks.readPushSettings.mockResolvedValue({ pushMode: 'realtime', minScore: 75, minRelevance: 70 });
    mocks.eventFindFirst.mockResolvedValue({ id: 'deferred-event' });
    mocks.runJob.mockResolvedValue({ queued: true, jobId: 'realtime-retry' });
    const { maybeEnqueueRealtimePush } = await import('@/lib/scheduler');

    await maybeEnqueueRealtimePush({
      push_mode: 'realtime',
      crawl_quiet_start: '22:00',
      crawl_quiet_end: '08:00',
    });

    expect(mocks.runJob).toHaveBeenCalledWith('push', expect.objectContaining({
      trigger: 'auto_retry',
      idempotencyKey: 'realtime-push:2026-08-05T08:00',
    }));
  });
});
