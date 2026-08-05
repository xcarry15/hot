-- Public URLs are Event-based. Store cumulative totals on Event and durable
-- Asia/Shanghai daily interaction facts so range-based analytics never has to
-- infer an interaction date from Article.createdAt.
ALTER TABLE "events" ADD COLUMN "viewCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "events" ADD COLUMN "originalClickCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "event_interaction_daily" (
    "eventId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "originalClickCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("eventId", "sourceId", "dateKey"),
    CONSTRAINT "event_interaction_daily_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "event_interaction_daily_dateKey_sourceId_idx" ON "event_interaction_daily"("dateKey", "sourceId");
CREATE INDEX "event_interaction_daily_eventId_dateKey_idx" ON "event_interaction_daily"("eventId", "dateKey");
