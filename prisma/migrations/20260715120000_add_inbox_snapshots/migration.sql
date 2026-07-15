CREATE TABLE "inbox_snapshots" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "capturedOn" DATETIME NOT NULL,
  "pendingCount" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "inbox_snapshots_capturedOn_key" ON "inbox_snapshots"("capturedOn");
CREATE INDEX "inbox_snapshots_capturedOn_idx" ON "inbox_snapshots"("capturedOn");
