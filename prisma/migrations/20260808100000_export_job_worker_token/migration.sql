-- Add a per-claim worker token so a stale worker cannot finish a newer claim.
ALTER TABLE "export_jobs" ADD COLUMN "workerToken" TEXT NOT NULL DEFAULT '';
