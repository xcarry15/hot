ALTER TABLE "events" ADD COLUMN "publicDateKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "events" ADD COLUMN "publicSortAt" DATETIME;

CREATE INDEX "events_status_publicStatus_publicDateKey_publicSortAt_idx"
ON "events"("status", "publicStatus", "publicDateKey", "publicSortAt");
