import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';

/**
 * SQLite 单实例仍可能在部署重叠、PM2 配置失误或 HMR 时出现多个 Node 进程。
 * 使用一条内部 Setting 作为 compare-and-swap 租约，不让 Job 正确性依赖进程内变量。
 * 该 key 不在设置目录中，不会出现在用户设置、导入或导出里。
 */
const JOB_RUNNER_LEASE_KEY = '__runtime_job_runner_lease__';
const JOB_RUNNER_LEASE_TTL_MS = 90_000;

export interface JobRunnerLease {
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

function isExpiredLease(value: string, now: Date): boolean {
  if (!value) return true;
  const [expiresAt] = value.split('|', 1);
  const timestamp = Date.parse(expiresAt ?? '');
  return !Number.isFinite(timestamp) || timestamp <= now.getTime();
}

function nextLeaseValue(token: string): string {
  return `${new Date(Date.now() + JOB_RUNNER_LEASE_TTL_MS).toISOString()}|${token}`;
}

/**
 * 原子领取全局执行权。先读当前值、再按该精确值更新，竞争方只能有一个成功。
 */
export async function acquireJobRunnerLease(): Promise<JobRunnerLease | null> {
  await db.setting.upsert({
    where: { key: JOB_RUNNER_LEASE_KEY },
    update: {},
    create: { key: JOB_RUNNER_LEASE_KEY, value: '' },
  });
  const current = await db.setting.findUnique({
    where: { key: JOB_RUNNER_LEASE_KEY },
    select: { value: true },
  });
  const previousValue = current?.value ?? '';
  if (!isExpiredLease(previousValue, new Date())) return null;

  const token = randomUUID();
  let value = nextLeaseValue(token);
  const claimed = await db.setting.updateMany({
    where: { key: JOB_RUNNER_LEASE_KEY, value: previousValue },
    data: { value },
  });
  if (claimed.count !== 1) return null;

  let released = false;
  return {
    async renew(): Promise<boolean> {
      if (released) return false;
      const nextValue = nextLeaseValue(token);
      const renewed = await db.setting.updateMany({
        where: { key: JOB_RUNNER_LEASE_KEY, value },
        data: { value: nextValue },
      });
      if (renewed.count !== 1) return false;
      value = nextValue;
      return true;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await db.setting.updateMany({
        where: { key: JOB_RUNNER_LEASE_KEY, value },
        data: { value: '' },
      });
    },
  };
}

/** 启动时仅清掉已过期的锁，绝不抢占仍在续租的其他进程。 */
export async function clearExpiredJobRunnerLease(): Promise<void> {
  const current = await db.setting.findUnique({
    where: { key: JOB_RUNNER_LEASE_KEY },
    select: { value: true },
  });
  if (!current || !isExpiredLease(current.value, new Date())) return;
  await db.setting.updateMany({
    where: { key: JOB_RUNNER_LEASE_KEY, value: current.value },
    data: { value: '' },
  });
}

export const jobRunnerLeaseKeyForTest = JOB_RUNNER_LEASE_KEY;
