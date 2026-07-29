import { db } from './db';

async function checkJobCancellation(jobId: string): Promise<boolean> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  return job?.status === 'cancel_requested';
}

export async function assertJobNotCancelled(jobId: string): Promise<void> {
  if (await checkJobCancellation(jobId)) {
    throw new Error('Job cancelled');
  }
}
