-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'html',
    "url" TEXT NOT NULL,
    "parserConfig" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'never_fetched',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "circuitBreakerUntil" DATETIME,
    "lastFetchedAt" DATETIME,
    "fetchIntervalMin" INTEGER NOT NULL DEFAULT 30,
    "avgScore" REAL NOT NULL DEFAULT 0,
    "totalArticles" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "articles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "originalSource" TEXT,
    "rawContent" TEXT NOT NULL DEFAULT '',
    "cleanContent" TEXT NOT NULL DEFAULT '',
    "contentHash" TEXT NOT NULL DEFAULT '',
    "fetchStatus" TEXT NOT NULL DEFAULT 'pending',
    "articleBody" TEXT NOT NULL DEFAULT '',
    "relevance" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT NOT NULL DEFAULT '',
    "brand" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "keyPoints" TEXT NOT NULL DEFAULT '[]',
    "score" INTEGER NOT NULL DEFAULT 0,
    "promptVersion" TEXT NOT NULL DEFAULT 'v1',
    "aiStatus" TEXT NOT NULL DEFAULT 'pending',
    "skipReason" TEXT,
    "dedupDetail" TEXT,
    "aiRetryCount" INTEGER NOT NULL DEFAULT 0,
    "nextAiRetryAt" DATETIME,
    "isAd" BOOLEAN NOT NULL DEFAULT false,
    "pushedAt" DATETIME,
    "nextRetryAt" DATETIME,
    "pushUrgency" TEXT NOT NULL DEFAULT 'normal',
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "articles_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "keywords" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL DEFAULT '正面',
    "word" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "fetch_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL DEFAULT '',
    "itemsFound" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fetch_logs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "push_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "articleId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL DEFAULT '',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "webhookUrl" TEXT NOT NULL DEFAULT '',
    "webhookRemark" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_logs_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "discarded_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "winnerArticleId" TEXT,
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "discarded_items_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" TEXT NOT NULL DEFAULT '{}',
    "result" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "completedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "articles_contentHash_idx" ON "articles"("contentHash");

-- CreateIndex
CREATE INDEX "articles_fetchStatus_idx" ON "articles"("fetchStatus");

-- CreateIndex
CREATE INDEX "articles_aiStatus_createdAt_idx" ON "articles"("aiStatus", "createdAt");

-- CreateIndex
CREATE INDEX "articles_pushedAt_score_relevance_aiStatus_idx" ON "articles"("pushedAt", "score", "relevance", "aiStatus");

-- CreateIndex
CREATE INDEX "articles_brand_createdAt_idx" ON "articles"("brand", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "articles_url_key" ON "articles"("url");

-- CreateIndex
CREATE UNIQUE INDEX "keywords_category_word_key" ON "keywords"("category", "word");

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");

-- CreateIndex
CREATE INDEX "discarded_items_sourceId_createdAt_idx" ON "discarded_items"("sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "discarded_items_winnerArticleId_idx" ON "discarded_items"("winnerArticleId");

-- CreateIndex
CREATE UNIQUE INDEX "discarded_items_url_reason_key" ON "discarded_items"("url", "reason");

-- CreateIndex
CREATE INDEX "jobs_status_createdAt_idx" ON "jobs"("status", "createdAt");

