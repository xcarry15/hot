-- PushLog 只通过目标外键追溯投递对象，Webhook URL 不再入库。
-- PushTarget 的启用状态与凭据始终由受加密保护的 Settings 配置提供，移除未生效的重复字段。
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_push_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "representativeArticleId" TEXT,
    "targetId" TEXT,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL DEFAULT '',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "webhookRemark" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_logs_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "push_logs_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "push_targets" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_push_logs" ("createdAt", "errorMessage", "eventId", "id", "representativeArticleId", "retryCount", "status", "targetId", "webhookRemark")
SELECT "createdAt", "errorMessage", "eventId", "id", "representativeArticleId", "retryCount", "status", "targetId", "webhookRemark"
FROM "push_logs";
DROP TABLE "push_logs";
ALTER TABLE "new_push_logs" RENAME TO "push_logs";
CREATE INDEX "push_logs_eventId_targetId_status_idx" ON "push_logs"("eventId", "targetId", "status");
CREATE INDEX "push_logs_eventId_status_idx" ON "push_logs"("eventId", "status");
CREATE INDEX "push_logs_status_webhookRemark_createdAt_idx" ON "push_logs"("status", "webhookRemark", "createdAt");
CREATE INDEX "push_logs_createdAt_idx" ON "push_logs"("createdAt");

CREATE TABLE "new_push_targets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "urlHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_push_targets" ("createdAt", "id", "name", "updatedAt", "urlHash")
SELECT "createdAt", "id", "name", "updatedAt", "urlHash"
FROM "push_targets";
DROP TABLE "push_targets";
ALTER TABLE "new_push_targets" RENAME TO "push_targets";
CREATE UNIQUE INDEX "push_targets_urlHash_key" ON "push_targets"("urlHash");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
