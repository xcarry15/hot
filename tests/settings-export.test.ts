/**
 * POST /api/settings/export 导出端点测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ settingFindMany: vi.fn() }));

vi.mock('@/lib/db', () => ({
  db: { setting: { findMany: mocks.settingFindMany } },
}));

import { POST as exportPOST } from '@/app/api/settings/export/route';
import { EXPORTABLE_SETTING_KEYS } from '@/lib/settings';

describe('POST /api/settings/export', () => {
  beforeEach(() => vi.clearAllMocks());

  it('返回信封和可导出配置，不包含敏感凭证', async () => {
    mocks.settingFindMany.mockResolvedValue([
      { key: 'ai_provider', value: 'deepseek' },
      { key: 'push_min_score', value: '60' },
    ]);

    const res = await exportPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.type).toBe('hot2-settings');
    expect(body.version).toBe(1);
    expect(typeof body.exportedAt).toBe('string');
    expect(body.settings.deepseek_api_key).toBeUndefined();
    expect(body.settings.feishu_webhook_url).toBeUndefined();
    expect(body.settings.ai_provider).toBe('deepseek');
    expect(body.settings.push_min_score).toBe('60');
  });

  it('只按 EXPORTABLE_SETTING_KEYS 过滤，排除运行态键', async () => {
    // Prisma 的 where.key.in 已经把运行态键拦在 DB 侧——mock 模拟此契约
    mocks.settingFindMany.mockResolvedValue([
      { key: 'ai_provider', value: 'opencode' },
    ]);

    const res = await exportPOST();
    const body = await res.json();

    expect(body.settings.ai_provider).toBe('opencode');
    expect('scheduler_last_crawl_at' in body.settings).toBe(false);
    // 关键:findMany 用 where.key.in 限定清单(服务端信任边界在此,客户端可不可信无关)
    const arg = mocks.settingFindMany.mock.calls[0][0];
    expect(arg.where.key.in).toEqual(Array.from(EXPORTABLE_SETTING_KEYS));
    expect(arg.where.key.in).not.toContain('scheduler_last_crawl_at');
    expect(arg.where.key.in).not.toContain('scheduler_last_push_date');
  });
});
