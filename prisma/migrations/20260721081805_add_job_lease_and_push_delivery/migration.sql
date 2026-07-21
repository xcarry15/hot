-- CreateTable
CREATE TABLE "push_targets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "urlHash" TEXT NOT NULL,
    "secretRef" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "push_deliveries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "representativeArticleId" TEXT,
    "contentVersion" TEXT NOT NULL DEFAULT '',
    "mode" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT NOT NULL DEFAULT '',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT NOT NULL DEFAULT '',
    "leaseOwner" TEXT NOT NULL DEFAULT '',
    "leaseExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "push_deliveries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "push_deliveries_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "push_targets" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "event_dirty" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payload" TEXT NOT NULL DEFAULT '{}',
    "result" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT NOT NULL DEFAULT '',
    "currentStage" TEXT,
    "progressTotal" INTEGER NOT NULL DEFAULT 0,
    "progressDone" INTEGER NOT NULL DEFAULT 0,
    "progressErrors" INTEGER NOT NULL DEFAULT 0,
    "currentItemLabel" TEXT NOT NULL DEFAULT '',
    "heartbeatAt" DATETIME,
    "leaseOwner" TEXT NOT NULL DEFAULT '',
    "leaseExpiresAt" DATETIME,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "idempotencyKey" TEXT NOT NULL DEFAULT '',
    "availableAt" DATETIME,
    "cancelRequestedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "completedAt" DATETIME
);
INSERT INTO "new_jobs" ("completedAt", "createdAt", "currentItemLabel", "currentStage", "error", "heartbeatAt", "id", "payload", "progressDone", "progressErrors", "progressTotal", "result", "startedAt", "status", "type", "updatedAt") SELECT "completedAt", "createdAt", "currentItemLabel", "currentStage", "error", "heartbeatAt", "id", "payload", "progressDone", "progressErrors", "progressTotal", "result", "startedAt", "status", "type", "updatedAt" FROM "jobs";
DROP TABLE "jobs";
ALTER TABLE "new_jobs" RENAME TO "jobs";
CREATE INDEX "jobs_status_createdAt_idx" ON "jobs"("status", "createdAt");
CREATE INDEX "jobs_status_availableAt_leaseExpiresAt_idx" ON "jobs"("status", "availableAt", "leaseExpiresAt");
CREATE INDEX "jobs_idempotencyKey_idx" ON "jobs"("idempotencyKey");
CREATE TABLE "new_push_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "representativeArticleId" TEXT,
    "targetId" TEXT,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL DEFAULT '',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "webhookUrl" TEXT NOT NULL DEFAULT '',
    "webhookRemark" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_logs_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "push_logs_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "push_targets" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_push_logs" ("createdAt", "errorMessage", "eventId", "id", "representativeArticleId", "retryCount", "status", "webhookRemark", "webhookUrl") SELECT "createdAt", "errorMessage", "eventId", "id", "representativeArticleId", "retryCount", "status", "webhookRemark", "webhookUrl" FROM "push_logs";
DROP TABLE "push_logs";
ALTER TABLE "new_push_logs" RENAME TO "push_logs";
CREATE INDEX "push_logs_eventId_targetId_status_idx" ON "push_logs"("eventId", "targetId", "status");
CREATE INDEX "push_logs_eventId_status_idx" ON "push_logs"("eventId", "status");
CREATE INDEX "push_logs_status_webhookRemark_createdAt_idx" ON "push_logs"("status", "webhookRemark", "createdAt");
CREATE INDEX "push_logs_createdAt_idx" ON "push_logs"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "push_targets_urlHash_key" ON "push_targets"("urlHash");

-- CreateIndex
CREATE INDEX "push_deliveries_status_leaseExpiresAt_idx" ON "push_deliveries"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "push_deliveries_idempotencyKey_idx" ON "push_deliveries"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "push_deliveries_eventId_targetId_contentVersion_mode_key" ON "push_deliveries"("eventId", "targetId", "contentVersion", "mode");

-- CreateIndex
CREATE INDEX "event_dirty_eventId_idx" ON "event_dirty"("eventId");
