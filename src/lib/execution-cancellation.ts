import { db } from './db';
import { CANCELLED_JOB_STATUSES } from './job-status';
import { assertJobRunnerCurrent, getJobLeaseOwner, JobLeaseLostError } from './job-context';

async function checkJobCancellation(jobId: string): Promise<boolean> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { status: true, leaseOwner: true, leaseExpiresAt: true },
  });
  const owner = getJobLeaseOwner(jobId);
  if (owner) {
    if (!job || job.leaseOwner !== owner || !job.leaseExpiresAt || job.leaseExpiresAt <= new Date()) {
      throw new JobLeaseLostError();
    }
    if (job.status !== 'running' && !CANCELLED_JOB_STATUSES.includes(job.status)) {
      throw new JobLeaseLostError();
    }
  }
  return Boolean(job && CANCELLED_JOB_STATUSES.includes(job.status));
}

export async function assertJobNotCancelled(jobId: string): Promise<void> {
  await assertJobRunnerCurrent();
  if (await checkJobCancellation(jobId)) {
    throw new Error('Job cancelled');
  }
}
