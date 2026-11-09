CREATE TABLE "visit_sessions" (
  "id" TEXT NOT NULL PRIMARY KEY, "visitorId" TEXT NOT NULL,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dateKey" TEXT NOT NULL, "region" TEXT NOT NULL, "city" TEXT NOT NULL, "channel" TEXT NOT NULL
);
CREATE INDEX "visit_sessions_visitorId_lastAt_idx" ON "visit_sessions"("visitorId", "lastAt");
CREATE INDEX "visit_sessions_dateKey_idx" ON "visit_sessions"("dateKey");
CREATE TABLE "visit_events" (
  "id" TEXT NOT NULL PRIMARY KEY, "sessionId" TEXT NOT NULL, "visitorId" TEXT NOT NULL,
  "dateKey" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "visit_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "visit_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "visit_events_dateKey_kind_idx" ON "visit_events"("dateKey", "kind");
CREATE INDEX "visit_events_visitorId_dateKey_idx" ON "visit_events"("visitorId", "dateKey");
CREATE TABLE "visit_tool_daily" (
  "dateKey" TEXT NOT NULL, "toolId" TEXT NOT NULL, "toolName" TEXT NOT NULL, "clicks" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("dateKey", "toolId")
);
