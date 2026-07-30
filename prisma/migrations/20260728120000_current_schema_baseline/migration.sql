-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'html',
    "url" TEXT NOT NULL,
    "parserConfig" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "publicEnabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'never_fetched',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "circuitBreakerUntil" DATETIME,
    "lastFetchedAt" DATETIME,
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
    "eventId" TEXT,
    "clusterStatus" TEXT NOT NULL DEFAULT 'pending',
    "clusteredAt" DATETIME,
    "clusterError" TEXT,
    "clusterRetryCount" INTEGER NOT NULL DEFAULT 0,
    "nextClusterRetryAt" DATETIME,
    "eventSubjects" TEXT NOT NULL DEFAULT '[]',
    "eventAction" TEXT NOT NULL DEFAULT '',
    "eventObject" TEXT NOT NULL DEFAULT '',
    "eventKey" TEXT NOT NULL DEFAULT '',
    "eventKeyConfidence" INTEGER,
    "fetchStatus" TEXT NOT NULL DEFAULT 'pending',
    "fetchError" TEXT,
    "fetchRetryCount" INTEGER NOT NULL DEFAULT 0,
    "nextFetchRetryAt" DATETIME,
    "technicalIgnoredAt" DATETIME,
    "articleBody" TEXT NOT NULL DEFAULT '',
    "relevance" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT NOT NULL DEFAULT '',
    "brand" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "keyPoints" TEXT NOT NULL DEFAULT '[]',
    "score" INTEGER NOT NULL DEFAULT 0,
    "keywordMatched" BOOLEAN NOT NULL DEFAULT false,
    "eventScore" INTEGER,
    "contentScore" INTEGER,
    "rawScore" INTEGER,
    "adProbability" INTEGER,
    "aiConfidence" INTEGER,
    "scorePolicyVersion" TEXT NOT NULL DEFAULT '',
    "aiModel" TEXT NOT NULL DEFAULT '',
    "aiProvider" TEXT NOT NULL DEFAULT '',
    "promptHash" TEXT NOT NULL DEFAULT '',
    "scorePolicySnapshot" TEXT NOT NULL DEFAULT '',
    "promptVersion" TEXT NOT NULL DEFAULT 'v1',
    "aiStatus" TEXT NOT NULL DEFAULT 'pending',
    "aiError" TEXT,
    "aiSnapshot" TEXT NOT NULL DEFAULT '{}',
    "manualOverrides" TEXT NOT NULL DEFAULT '[]',
    "manualCorrectedAt" DATETIME,
    "skipReason" TEXT,
    "aiRetryCount" INTEGER NOT NULL DEFAULT 0,
    "nextAiRetryAt" DATETIME,
    "isAd" BOOLEAN NOT NULL DEFAULT false,
    "publicOverride" TEXT NOT NULL DEFAULT 'auto',
    "publicStatus" TEXT NOT NULL DEFAULT 'unpublished',
    "publicPublishedAt" DATETIME,
    "publicRevokedAt" DATETIME,
    "publicPublicationReason" TEXT NOT NULL DEFAULT '',
    "publicPublicationEvaluatedAt" DATETIME,
    "publicContentUpdatedAt" DATETIME,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "originalClickCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "articles_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "articles_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "article_search" (
    "articleId" TEXT NOT NULL PRIMARY KEY,
    "searchText" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "article_search_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'active',
    "clusterReviewStatus" TEXT NOT NULL DEFAULT 'confirmed',
    "mergedIntoId" TEXT,
    "representativeArticleId" TEXT,
    "representativeManual" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL,
    "articleCount" INTEGER NOT NULL DEFAULT 0,
    "publicStatus" TEXT NOT NULL DEFAULT 'unpublished',
    "publicPublishedAt" DATETIME,
    "publicRevokedAt" DATETIME,
    "publicDateKey" TEXT NOT NULL DEFAULT '',
    "publicSortAt" DATETIME,
    "pushedAt" DATETIME,
    "nextPushRetryAt" DATETIME,
    "pushRetryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "events_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "events" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "events_representativeArticleId_fkey" FOREIGN KEY ("representativeArticleId") REFERENCES "articles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "event_cluster_audits" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "articleId" TEXT NOT NULL,
    "assignedEventId" TEXT NOT NULL,
    "candidateEventId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "decisionSource" TEXT NOT NULL,
    "confidence" INTEGER,
    "evidence" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "event_cluster_audits_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "event_cluster_audits_assignedEventId_fkey" FOREIGN KEY ("assignedEventId") REFERENCES "events" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "event_cluster_audits_candidateEventId_fkey" FOREIGN KEY ("candidateEventId") REFERENCES "events" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "keyword_candidates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phrase" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "sampleTitles" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "tuning_suggestions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" DATETIME
);

-- CreateTable
CREATE TABLE "keywords" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL DEFAULT '正面',
    "word" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "keyword_hits" (
    "articleId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "keyword_hits_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "keyword_hits_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "keywords" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY ("articleId", "keywordId")
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

-- CreateTable
CREATE TABLE "jobs" (
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

-- CreateIndex
CREATE INDEX "sources_deletedAt_status_idx" ON "sources"("deletedAt", "status");

-- CreateIndex
CREATE INDEX "articles_contentHash_idx" ON "articles"("contentHash");

-- CreateIndex
CREATE INDEX "articles_eventKey_publishedAt_idx" ON "articles"("eventKey", "publishedAt");

-- CreateIndex
CREATE INDEX "articles_eventId_createdAt_idx" ON "articles"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "articles_eventId_publishedAt_createdAt_idx" ON "articles"("eventId", "publishedAt", "createdAt");

-- CreateIndex
CREATE INDEX "articles_clusterStatus_nextClusterRetryAt_createdAt_idx" ON "articles"("clusterStatus", "nextClusterRetryAt", "createdAt");

-- CreateIndex
CREATE INDEX "articles_fetchStatus_idx" ON "articles"("fetchStatus");

-- CreateIndex
CREATE INDEX "articles_fetchStatus_nextFetchRetryAt_createdAt_idx" ON "articles"("fetchStatus", "nextFetchRetryAt", "createdAt");

-- CreateIndex
CREATE INDEX "articles_technicalIgnoredAt_updatedAt_idx" ON "articles"("technicalIgnoredAt", "updatedAt");

-- CreateIndex
CREATE INDEX "articles_aiStatus_createdAt_idx" ON "articles"("aiStatus", "createdAt");

-- CreateIndex
CREATE INDEX "articles_aiStatus_nextAiRetryAt_createdAt_idx" ON "articles"("aiStatus", "nextAiRetryAt", "createdAt");

-- CreateIndex
CREATE INDEX "articles_brand_createdAt_idx" ON "articles"("brand", "createdAt");

-- CreateIndex
CREATE INDEX "articles_publicOverride_publishedAt_idx" ON "articles"("publicOverride", "publishedAt");

-- CreateIndex
CREATE INDEX "articles_publicStatus_publishedAt_idx" ON "articles"("publicStatus", "publishedAt");

-- CreateIndex
CREATE INDEX "articles_publicStatus_publicContentUpdatedAt_idx" ON "articles"("publicStatus", "publicContentUpdatedAt");

-- CreateIndex
CREATE INDEX "keyword_hits_keywordId_createdAt_idx" ON "keyword_hits"("keywordId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "articles_url_key" ON "articles"("url");

-- CreateIndex
CREATE UNIQUE INDEX "events_representativeArticleId_key" ON "events"("representativeArticleId");

-- CreateIndex
CREATE INDEX "events_status_clusterReviewStatus_lastSeenAt_idx" ON "events"("status", "clusterReviewStatus", "lastSeenAt");

-- CreateIndex
CREATE INDEX "events_publicStatus_firstSeenAt_idx" ON "events"("publicStatus", "firstSeenAt");

-- CreateIndex
CREATE INDEX "events_status_publicStatus_publicDateKey_publicSortAt_idx" ON "events"("status", "publicStatus", "publicDateKey", "publicSortAt");

-- CreateIndex
CREATE INDEX "events_pushedAt_nextPushRetryAt_idx" ON "events"("pushedAt", "nextPushRetryAt");

-- CreateIndex
CREATE INDEX "event_cluster_audits_articleId_createdAt_idx" ON "event_cluster_audits"("articleId", "createdAt");

-- CreateIndex
CREATE INDEX "event_cluster_audits_assignedEventId_createdAt_idx" ON "event_cluster_audits"("assignedEventId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "keyword_candidates_phrase_key" ON "keyword_candidates"("phrase");

-- CreateIndex
CREATE INDEX "keyword_candidates_status_occurrences_idx" ON "keyword_candidates"("status", "occurrences");

-- CreateIndex
CREATE INDEX "tuning_suggestions_status_createdAt_idx" ON "tuning_suggestions"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "keywords_category_word_key" ON "keywords"("category", "word");

-- CreateIndex
CREATE INDEX "fetch_logs_sourceId_status_createdAt_idx" ON "fetch_logs"("sourceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "fetch_logs_createdAt_idx" ON "fetch_logs"("createdAt");

-- CreateIndex
CREATE INDEX "push_logs_eventId_targetId_status_idx" ON "push_logs"("eventId", "targetId", "status");

-- CreateIndex
CREATE INDEX "push_logs_eventId_status_idx" ON "push_logs"("eventId", "status");

-- CreateIndex
CREATE INDEX "push_logs_status_webhookRemark_createdAt_idx" ON "push_logs"("status", "webhookRemark", "createdAt");

-- CreateIndex
CREATE INDEX "push_logs_createdAt_idx" ON "push_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "push_targets_urlHash_key" ON "push_targets"("urlHash");

-- CreateIndex
CREATE INDEX "push_deliveries_status_leaseExpiresAt_idx" ON "push_deliveries"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "push_deliveries_idempotencyKey_idx" ON "push_deliveries"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "push_deliveries_eventId_targetId_contentVersion_mode_key" ON "push_deliveries"("eventId", "targetId", "contentVersion", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "event_dirty_eventId_key" ON "event_dirty"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");

-- CreateIndex
CREATE INDEX "discarded_items_sourceId_createdAt_idx" ON "discarded_items"("sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "discarded_items_reason_createdAt_idx" ON "discarded_items"("reason", "createdAt");

-- CreateIndex
CREATE INDEX "discarded_items_winnerArticleId_idx" ON "discarded_items"("winnerArticleId");

-- CreateIndex
CREATE UNIQUE INDEX "discarded_items_url_reason_key" ON "discarded_items"("url", "reason");

-- CreateIndex
CREATE INDEX "discarded_retry_audits_discardedId_createdAt_idx" ON "discarded_retry_audits"("discardedId", "createdAt");

-- CreateIndex
CREATE INDEX "discarded_retry_audits_sourceId_createdAt_idx" ON "discarded_retry_audits"("sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "jobs_status_createdAt_idx" ON "jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "jobs_status_availableAt_leaseExpiresAt_idx" ON "jobs"("status", "availableAt", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "jobs_idempotencyKey_idx" ON "jobs"("idempotencyKey");
