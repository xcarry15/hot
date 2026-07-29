import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cleanupExpiredSendingDeliveries: vi.fn(),
  resetOrphanedJobs: vi.fn(),
  resumeQueuedJob: vi.fn(),
  runJob: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  readAllSettings: vi.fn(),
  hasDueTechnicalRecovery: vi.fn(),
  hasDirtyEvents: vi.fn(),
  hasPendingSettingsRebuild: vi.fn(),
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
    SCHEDULER_LAST_CRAWL_AT: 'scheduler_last_crawl_at',
    SCHEDULER_LAST_PUSH_DATE: 'scheduler_last_push_date',
    PUSH_MODE: 'push_mode',
    PUSH_TIME: 'push_time',
  },
}));

vi.mock('@/lib/push/delivery', () => ({
  cleanupExpiredSendingDeliveries: mocks.cleanupExpiredSendingDeliveries,
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cleanupExpiredSendingDeliveries.mockResolvedValue(0);
    mocks.resetOrphanedJobs.mockResolvedValue(0);
    mocks.resumeQueuedJob.mockResolvedValue(null);
    mocks.readAllSettings.mockResolvedValue({
      auto_crawl_enabled: 'false',
      push_mode: 'off',
    });
    mocks.hasDueTechnicalRecovery.mockResolvedValue(false);
    mocks.hasDirtyEvents.mockResolvedValue(false);
    mocks.hasPendingSettingsRebuild.mockResolvedValue(false);
  });

  it('每个调度 tick 都收口过期 sending 投递，再执行正常调度检查', async () => {
    await runSchedulerTick();

    expect(mocks.resetOrphanedJobs).toHaveBeenCalledTimes(1);
    expect(mocks.resumeQueuedJob).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupExpiredSendingDeliveries).toHaveBeenCalledTimes(1);
    expect(mocks.readAllSettings).toHaveBeenCalledTimes(1);
    expect(mocks.runJob).not.toHaveBeenCalled();
  });
});
