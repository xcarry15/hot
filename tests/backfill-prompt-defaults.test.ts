/**
 * scripts/backfill-prompt-defaults.ts 行为测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runBackfill, PROMPT_BACKFILL } from '../scripts/backfill-prompt-defaults';
import {
  DEFAULT_SYSTEM_PROMPT,
  PROMPT_BLOCK_META,
  PROMPT_BLOCK_ORDER,
} from '../src/lib/prompts';

describe('PROMPT_BACKFILL', () => {
  it('包含 1 个 system prompt + 9 个 block', () => {
    expect(PROMPT_BACKFILL.length).toBe(1 + PROMPT_BLOCK_ORDER.length);
  });

  it('system prompt 值为 DEFAULT_SYSTEM_PROMPT', () => {
    expect(PROMPT_BACKFILL[0]).toEqual({ key: 'ai_system_prompt', value: DEFAULT_SYSTEM_PROMPT });
  });

  it('每个 block 键值对齐 PROMPT_BLOCK_META', () => {
    for (let i = 0; i < PROMPT_BLOCK_ORDER.length; i++) {
      const id = PROMPT_BLOCK_ORDER[i];
      const meta = PROMPT_BLOCK_META[id];
      expect(PROMPT_BACKFILL[1 + i]).toEqual({ key: meta.key, value: meta.defaultBlock });
    }
  });
});

describe('runBackfill', () => {
  let db: {
    setting: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    db = { setting: { findUnique: vi.fn(), upsert: vi.fn() } };
  });

  it('空串/缺失行用 defaultBlock 回填,已有非空行跳过', async () => {
    db.setting.findUnique.mockImplementation(({ where: { key } }: { where: { key: string } }) => {
      if (key === 'ai_block_key_points') {
        return Promise.resolve({ key, value: '用户的自定义 key_points', updatedAt: new Date() });
      }
      if (key === 'ai_block_summary') {
        return Promise.resolve({ key, value: '', updatedAt: new Date() });
      }
      return Promise.resolve(null);
    });

    const { filled, skipped } = await runBackfill(db as never);
    // 10 - 1 (用户自定义跳过) = 9 回填
    expect(filled).toBe(PROMPT_BACKFILL.length - 1);
    expect(skipped).toBe(1);

    // key_points 不应被 upsert(用户已有内容)
    const upsertedKeys = db.setting.upsert.mock.calls.map(
      (c: unknown[]) => (c[0] as { where: { key: string } }).where.key,
    );
    expect(upsertedKeys).not.toContain('ai_block_key_points');
    expect(upsertedKeys).toContain('ai_block_summary'); // 空串也应被回填
    expect(upsertedKeys).toContain('ai_system_prompt');
  });

  it('回填使用 defaultBlock 文本', async () => {
    db.setting.findUnique.mockResolvedValue(null);
    await runBackfill(db as never);

    const summaryCall = db.setting.upsert.mock.calls.find(
      (c: unknown[]) => (c[0] as { where: { key: string } }).where.key === 'ai_block_summary',
    );
    expect(summaryCall).toBeDefined();
    expect((summaryCall![0] as { create: { value: string } }).create.value).toBe(
      PROMPT_BLOCK_META.summary.defaultBlock,
    );
  });
});
