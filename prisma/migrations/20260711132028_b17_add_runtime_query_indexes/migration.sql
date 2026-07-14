-- CreateIndex
CREATE INDEX "articles_aiStatus_nextAiRetryAt_createdAt_idx" ON "articles"("aiStatus", "nextAiRetryAt", "createdAt");

-- CreateIndex
CREATE INDEX "discarded_items_reason_createdAt_idx" ON "discarded_items"("reason", "createdAt");

-- CreateIndex
CREATE INDEX "sources_deletedAt_status_idx" ON "sources"("deletedAt", "status");
