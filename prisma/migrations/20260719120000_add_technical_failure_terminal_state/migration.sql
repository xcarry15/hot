ALTER TABLE "articles" ADD COLUMN "fetchRetryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "articles" ADD COLUMN "nextFetchRetryAt" DATETIME;
ALTER TABLE "articles" ADD COLUMN "technicalIgnoredAt" DATETIME;
ALTER TABLE "events" ADD COLUMN "pushRetryCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "articles_fetchStatus_nextFetchRetryAt_createdAt_idx" ON "articles"("fetchStatus", "nextFetchRetryAt", "createdAt");
CREATE INDEX "articles_technicalIgnoredAt_updatedAt_idx" ON "articles"("technicalIgnoredAt", "updatedAt");
