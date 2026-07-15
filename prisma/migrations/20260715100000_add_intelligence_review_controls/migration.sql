-- Intelligence inbox, public overrides, engagement counters and keyword feedback.
ALTER TABLE "sources" ADD COLUMN "publicEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "articles" ADD COLUMN "reviewStatus" TEXT NOT NULL DEFAULT 'unreviewed';
ALTER TABLE "articles" ADD COLUMN "reviewReasonTags" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "articles" ADD COLUMN "reviewedAt" DATETIME;
ALTER TABLE "articles" ADD COLUMN "publicOverride" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "articles" ADD COLUMN "pinUntil" DATETIME;
ALTER TABLE "articles" ADD COLUMN "duplicateOfId" TEXT;
ALTER TABLE "articles" ADD COLUMN "duplicateStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "articles" ADD COLUMN "dedupOverride" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "articles" ADD COLUMN "viewCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "articles" ADD COLUMN "originalClickCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "articles_reviewStatus_aiStatus_fetchStatus_createdAt_idx" ON "articles"("reviewStatus", "aiStatus", "fetchStatus", "createdAt");
CREATE INDEX "articles_publicOverride_pinUntil_publishedAt_idx" ON "articles"("publicOverride", "pinUntil", "publishedAt");
CREATE INDEX "articles_duplicateStatus_createdAt_idx" ON "articles"("duplicateStatus", "createdAt");

CREATE TABLE "keyword_candidates" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "phrase" TEXT NOT NULL,
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "sampleTitles" TEXT NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "keyword_candidates_phrase_key" ON "keyword_candidates"("phrase");
CREATE INDEX "keyword_candidates_status_occurrences_idx" ON "keyword_candidates"("status", "occurrences");

CREATE TABLE "tuning_suggestions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "payload" TEXT NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" DATETIME
);
CREATE INDEX "tuning_suggestions_status_createdAt_idx" ON "tuning_suggestions"("status", "createdAt");
