-- CreateTable
CREATE TABLE "export_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "filterSnapshot" TEXT NOT NULL DEFAULT '{}',
    "snapshotAt" DATETIME NOT NULL,
    "progressTotal" INTEGER NOT NULL DEFAULT 0,
    "progressDone" INTEGER NOT NULL DEFAULT 0,
    "progressErrors" INTEGER NOT NULL DEFAULT 0,
    "currentSheet" TEXT NOT NULL DEFAULT '',
    "currentItemLabel" TEXT NOT NULL DEFAULT '',
    "fileName" TEXT NOT NULL DEFAULT '',
    "storageKey" TEXT NOT NULL DEFAULT '',
    "fileSizeBytes" INTEGER,
    "error" TEXT NOT NULL DEFAULT '',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "cancelRequestedAt" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "completedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "export_jobs_status_createdAt_idx" ON "export_jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "export_jobs_expiresAt_status_idx" ON "export_jobs"("expiresAt", "status");
