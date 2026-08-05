-- SQLite cannot add a NOT NULL column without a constant default. Rebuild the
-- small ledger table so the Prisma @updatedAt column has the same shape as the
-- schema, while preserving all existing delivery rows and indexes.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_push_deliveries" (
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
    "updatedAt" DATETIME NOT NULL,
    "sentAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "push_deliveries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "push_deliveries_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "push_targets" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_push_deliveries" (
    "attempt", "completedAt", "contentVersion", "createdAt", "eventId", "id",
    "idempotencyKey", "lastError", "leaseExpiresAt", "leaseOwner", "mode",
    "representativeArticleId", "sentAt", "status", "targetId", "updatedAt"
)
SELECT
    "attempt", "completedAt", "contentVersion", "createdAt", "eventId", "id",
    "idempotencyKey", "lastError", "leaseExpiresAt", "leaseOwner", "mode",
    "representativeArticleId", "sentAt", "status", "targetId",
    COALESCE("completedAt", "sentAt", "createdAt")
FROM "push_deliveries";

DROP TABLE "push_deliveries";
ALTER TABLE "new_push_deliveries" RENAME TO "push_deliveries";

CREATE INDEX "push_deliveries_eventId_targetId_updatedAt_idx" ON "push_deliveries"("eventId", "targetId", "updatedAt");
CREATE INDEX "push_deliveries_status_leaseExpiresAt_idx" ON "push_deliveries"("status", "leaseExpiresAt");
CREATE INDEX "push_deliveries_idempotencyKey_idx" ON "push_deliveries"("idempotencyKey");
CREATE UNIQUE INDEX "push_deliveries_eventId_targetId_contentVersion_mode_key" ON "push_deliveries"("eventId", "targetId", "contentVersion", "mode");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
