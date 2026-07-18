PRAGMA foreign_keys=OFF;

CREATE TABLE "events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "status" TEXT NOT NULL DEFAULT 'active',
  "mergedIntoId" TEXT,
  "representativeArticleId" TEXT,
  "representativeManual" BOOLEAN NOT NULL DEFAULT false,
  "firstSeenAt" DATETIME NOT NULL,
  "lastSeenAt" DATETIME NOT NULL,
  "articleCount" INTEGER NOT NULL DEFAULT 0,
  "publicStatus" TEXT NOT NULL DEFAULT 'unpublished',
  "publicPublishedAt" DATETIME,
  "publicRevokedAt" DATETIME,
  "pushedAt" DATETIME,
  "nextPushRetryAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "events_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "events" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "events_representativeArticleId_fkey" FOREIGN KEY ("representativeArticleId") REFERENCES "articles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "events_representativeArticleId_key" ON "events"("representativeArticleId");
CREATE INDEX "events_status_lastSeenAt_idx" ON "events"("status", "lastSeenAt");
CREATE INDEX "events_publicStatus_firstSeenAt_idx" ON "events"("publicStatus", "firstSeenAt");
CREATE INDEX "events_pushedAt_nextPushRetryAt_idx" ON "events"("pushedAt", "nextPushRetryAt");

ALTER TABLE "articles" ADD COLUMN "eventId" TEXT REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "articles" ADD COLUMN "clusterStatus" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "articles" ADD COLUMN "clusteredAt" DATETIME;
ALTER TABLE "articles" ADD COLUMN "clusterError" TEXT;
ALTER TABLE "articles" ADD COLUMN "clusterRetryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "articles" ADD COLUMN "nextClusterRetryAt" DATETIME;
ALTER TABLE "articles" ADD COLUMN "eventKey" TEXT NOT NULL DEFAULT '';

-- SQLite stores Prisma enums as TEXT, so existing jobs require no table rewrite.

CREATE INDEX "articles_eventId_createdAt_idx" ON "articles"("eventId", "createdAt");
CREATE INDEX "articles_clusterStatus_nextClusterRetryAt_createdAt_idx" ON "articles"("clusterStatus", "nextClusterRetryAt", "createdAt");

DROP INDEX IF EXISTS "articles_pushedAt_score_relevance_aiStatus_idx";
DROP INDEX IF EXISTS "articles_duplicateStatus_createdAt_idx";
ALTER TABLE "articles" DROP COLUMN "dedupDetail";
ALTER TABLE "articles" DROP COLUMN "duplicateOfId";
ALTER TABLE "articles" DROP COLUMN "duplicateStatus";
ALTER TABLE "articles" DROP COLUMN "dedupOverride";
ALTER TABLE "articles" DROP COLUMN "pushedAt";
ALTER TABLE "articles" DROP COLUMN "nextRetryAt";

CREATE TABLE "event_cluster_audits" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "articleId" TEXT NOT NULL,
  "assignedEventId" TEXT NOT NULL,
  "candidateEventId" TEXT,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "decisionSource" TEXT NOT NULL,
  "confidence" INTEGER,
  "evidence" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "event_cluster_audits_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "event_cluster_audits_assignedEventId_fkey" FOREIGN KEY ("assignedEventId") REFERENCES "events" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "event_cluster_audits_candidateEventId_fkey" FOREIGN KEY ("candidateEventId") REFERENCES "events" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "event_cluster_audits_articleId_createdAt_idx" ON "event_cluster_audits"("articleId", "createdAt");
CREATE INDEX "event_cluster_audits_assignedEventId_createdAt_idx" ON "event_cluster_audits"("assignedEventId", "createdAt");

CREATE TABLE "new_push_logs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "eventId" TEXT NOT NULL,
  "representativeArticleId" TEXT,
  "status" TEXT NOT NULL,
  "errorMessage" TEXT NOT NULL DEFAULT '',
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "webhookUrl" TEXT NOT NULL DEFAULT '',
  "webhookRemark" TEXT NOT NULL DEFAULT '',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "push_logs_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

DROP TABLE "push_logs";
ALTER TABLE "new_push_logs" RENAME TO "push_logs";
CREATE INDEX "push_logs_eventId_status_webhookUrl_idx" ON "push_logs"("eventId", "status", "webhookUrl");
CREATE INDEX "push_logs_status_webhookRemark_createdAt_idx" ON "push_logs"("status", "webhookRemark", "createdAt");
CREATE INDEX "push_logs_createdAt_idx" ON "push_logs"("createdAt");

PRAGMA foreign_keys=ON;
