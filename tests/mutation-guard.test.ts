import { describe, expect, it } from 'vitest';
import {
  MutationConflictError,
  getActiveMutationName,
  runExclusiveMutation,
  tryReserveMutation,
} from '@/lib/mutation-guard';

describe.sequential('single-process mutation guard', () => {
  it('在预约期间拒绝 Job 与同步写入，并只允许持有者释放', async () => {
    const job = tryReserveMutation('collect 任务', 'collect');
    expect(job).not.toBeNull();
    expect(getActiveMutationName()).toBe('collect 任务');
    await expect(runExclusiveMutation('单篇推送', async () => undefined)).rejects.toBeInstanceOf(MutationConflictError);
    expect(tryReserveMutation('push 任务', 'push')).toBeNull();
    job?.release();
    await expect(runExclusiveMutation('单篇推送', async () => 'ok')).resolves.toBe('ok');
    expect(getActiveMutationName()).toBeNull();
  });
});
