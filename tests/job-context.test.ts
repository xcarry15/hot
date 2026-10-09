import { describe, expect, it } from 'vitest';
import {
  getCurrentJobId, getJobLeaseOwner, getJobWriteWhere, JobLeaseLostError, runWithJobLease,
} from '@/lib/job-context';

describe('异步 Job 所有权上下文', () => {
  it('异步调用继承领取标识，嵌套执行结束后恢复外层上下文', async () => {
    await runWithJobLease({ jobId: 'j1', owner: 'owner1' }, async () => {
      await Promise.resolve();
      expect(getCurrentJobId()).toBe('j1');
      expect(getJobWriteWhere('j1')).toEqual({ id: 'j1', leaseOwner: 'owner1', leaseExpiresAt: { gt: expect.any(Date) } });
      await runWithJobLease({ jobId: 'j2', owner: 'owner2' }, async () => {
        expect(getCurrentJobId()).toBe('j2');
        expect(getJobLeaseOwner('j2')).toBe('owner2');
        expect(() => getJobWriteWhere('j1')).toThrow(JobLeaseLostError);
      });
      expect(getJobLeaseOwner('j1')).toBe('owner1');
    });
    expect(getCurrentJobId()).toBeUndefined();
  });

  it('没有本轮领取上下文时拒绝执行器写入', () => {
    expect(() => getJobWriteWhere('j1')).toThrow(JobLeaseLostError);
  });

  it('不同异步链的领取标识互不覆盖', async () => {
    await Promise.all(['owner1', 'owner2'].map((owner) => runWithJobLease({ jobId: 'j1', owner }, async () => {
      await Promise.resolve();
      expect(getJobLeaseOwner('j1')).toBe(owner);
      expect(getJobLeaseOwner('j2')).toBeUndefined();
    })));
  });
});
