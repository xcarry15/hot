/**
 * settings PUT 事务化回归测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  settingFindMany: vi.fn(),
  settingUpsert: vi.fn(),
  articleFindMany: vi.fn(),
  articleUpdate: vi.fn(),
  transaction: vi.fn(),
}));

mocks.settingUpsert.mockImplementation((args) => ({ _op: 'setting.upsert', args }));

vi.mock('@/lib/db', () => ({
  db: {
    setting: {
      findMany: mocks.settingFindMany,
      upsert: mocks.settingUpsert,
    },
    article: {
      findMany: mocks.articleFindMany,
      update: mocks.articleUpdate,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('@/lib/ai-client', () => ({
  invalidateAISettingsCache: vi.fn(),
}));

vi.mock('@/lib/event-service', () => ({
  recalculateEventById: vi.fn(),
}));

import { PUT as settingsPUT } from '@/app/api/settings/route';
import { DEFAULT_BLOCK_SUMMARY } from '@/lib/prompts';

describe('settings PUT 事务化', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingFindMany.mockResolvedValue([]);
    mocks.articleFindMany.mockResolvedValue([]);
    mocks.settingUpsert.mockImplementation((args) => ({ _op: 'setting.upsert', args }));
    mocks.transaction.mockImplementation(async (operation) => {
      if (Array.isArray(operation)) return Promise.all(operation);
      return operation({
        setting: { upsert: mocks.settingUpsert },
        article: { findMany: mocks.articleFindMany, update: mocks.articleUpdate },
      });
    });
  });

  it('多个 settings 更新：包在 $transaction 中', async () => {
    const updates = {
      ai_temperature: '0.7',
      push_min_score: '60',
      push_min_relevance: '7',
    };

    const req = new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });

    const res = await settingsPUT(req);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);

    // 关键：settingUpsert 被调 3 次，每次 1 个 key
    expect(mocks.settingUpsert).toHaveBeenCalledTimes(3);

    const upsertKeys = mocks.settingUpsert.mock.calls.map(c => c[0].where.key).sort();
    expect(upsertKeys).toEqual(['ai_temperature', 'push_min_relevance', 'push_min_score']);
  });

  it('无效 schema：拒绝，不调用 $transaction', async () => {
    const req = new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_temperature: 'invalid' }),
    });

    const res = await settingsPUT(req);
    expect(res.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('ai_temperature 越界值校验：2.5 被拒绝', async () => {
    const req = new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_temperature: '2.5' }),
    });

    const res = await settingsPUT(req);
    expect(res.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('ai_temperature 合法边界值通过', async () => {
    const req = new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_temperature: '1.9' }),
    });

    const res = await settingsPUT(req);
    expect(res.status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('不在 EXPORTABLE_SETTING_KEYS 的 key 被拒（服务端信任边界）', async () => {
    const req = new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_token: 'steal-me', scheduler_last_crawl_at: '2026-01-01' }),
    });

    const res = await settingsPUT(req);
    expect(res.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('空 body：仍通过事务回调提交（当前没有待更新项）', async () => {
    const req = new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await settingsPUT(req);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(typeof mocks.transaction.mock.calls[0][0]).toBe('function');
  });

  it('提示词保存空值时持久化当前默认文本', async () => {
    const req = new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_block_summary: '' }),
    });

    const res = await settingsPUT(req);

    expect(res.status).toBe(200);
    expect(mocks.settingUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'ai_block_summary' },
      create: { key: 'ai_block_summary', value: DEFAULT_BLOCK_SUMMARY },
      update: { value: DEFAULT_BLOCK_SUMMARY },
    }));
  });

  it('提示词保存纯空白时也持久化当前默认文本', async () => {
    const req = new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_block_summary: '   ' }),
    });

    const res = await settingsPUT(req);

    expect(res.status).toBe(200);
    expect(mocks.settingUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'ai_block_summary' },
      create: { key: 'ai_block_summary', value: DEFAULT_BLOCK_SUMMARY },
      update: { value: DEFAULT_BLOCK_SUMMARY },
    }));
  });

  it('关键词命中加分限定为 0-20', async () => {
    const req = new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_keyword_match_bonus: '21' }),
    });

    const res = await settingsPUT(req);

    expect(res.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
