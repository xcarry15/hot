/**
 * scripts/cleanup-legacy-settings.ts 行为测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCleanup, LEGACY_KEYS } from '../scripts/cleanup-legacy-settings';

describe('runCleanup', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let db: { setting: { deleteMany: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    db = { setting: { deleteMany: vi.fn() } };
  });

  it('命中遗留键时按预设集合删除并报告', async () => {
    db.setting.deleteMany.mockResolvedValue({ count: 5 });
    const n = await runCleanup(db as never);
    expect(n).toBe(5);

    expect(db.setting.deleteMany).toHaveBeenCalledTimes(1);
    const arg = db.setting.deleteMany.mock.calls[0][0];
    expect([...arg.where.key.in].sort()).toEqual([...LEGACY_KEYS].sort());
  });

  it('无遗留键时打印『无需清理』', async () => {
    db.setting.deleteMany.mockResolvedValue({ count: 0 });
    const n = await runCleanup(db as never);
    expect(n).toBe(0);

    const logs = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(logs).toContain('无遗留键');
  });

  it('LEGACY_KEYS 包含 5 个预期的键', () => {
    expect(LEGACY_KEYS).toEqual([
      'ai_step1_prompt',
      'ai_step2_prompt',
      'ai_weight_brand',
      'ai_block_brand_score',
      'ai_step1_summary_max_chars',
    ]);
  });
});
