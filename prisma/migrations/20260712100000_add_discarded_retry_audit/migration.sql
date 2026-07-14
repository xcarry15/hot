CREATE TABLE "discarded_retry_audits" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "discardedId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "winnerArticleId" TEXT,
    "publishedAt" DATETIME,
    "action" TEXT NOT NULL,
    "articleId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "discarded_retry_audits_discardedId_createdAt_idx"
ON "discarded_retry_audits"("discardedId", "createdAt");

CREATE INDEX "discarded_retry_audits_sourceId_createdAt_idx"
ON "discarded_retry_audits"("sourceId", "createdAt");
