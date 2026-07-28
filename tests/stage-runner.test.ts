import { describe, expect, it, vi } from 'vitest';
import { runStages } from '@/lib/pipeline/stage-runner';

describe('pipeline stage runner', () => {
  it('按声明顺序执行并跳过不满足条件的阶段', async () => {
    const order: string[] = [];
    const result = await runStages([
      { key: 'first', run: async () => { order.push('first'); return 1; } },
      { key: 'skipped', shouldRun: () => false, run: async () => { order.push('skipped'); return 2; } },
      { key: 'last', run: async () => { order.push('last'); return 3; } },
    ]);
    expect(order).toEqual(['first', 'last']);
    expect(result).toEqual({ first: 1, last: 3 });
  });

  it('只执行显式声明的错误补偿动作，然后继续抛出原错误', async () => {
    const onError = vi.fn(async () => undefined);
    await expect(runStages([
      { key: 'ai', run: async () => { throw new Error('provider'); }, onError },
    ])).rejects.toThrow('provider');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('补偿动作再次失败时仍保留原阶段错误', async () => {
    const original = new Error('process failed');
    const onError = vi.fn(async () => { throw new Error('compensation failed'); });

    await expect(runStages([
      { key: 'process', run: async () => { throw original; }, onError },
    ])).rejects.toBe(original);
    expect(onError).toHaveBeenCalledWith(original);
  });
});
