-- 重构 #6：为日志热查询和按时间清理增加索引。
-- 仅新增索引，不改写或删除任何历史日志数据；可回滚为 DROP INDEX。

CREATE INDEX "fetch_logs_sourceId_status_createdAt_idx"
ON "fetch_logs"("sourceId", "status", "createdAt");

CREATE INDEX "fetch_logs_createdAt_idx"
ON "fetch_logs"("createdAt");

CREATE INDEX "push_logs_articleId_status_webhookUrl_idx"
ON "push_logs"("articleId", "status", "webhookUrl");

CREATE INDEX "push_logs_status_webhookRemark_createdAt_idx"
ON "push_logs"("status", "webhookRemark", "createdAt");

CREATE INDEX "push_logs_createdAt_idx"
ON "push_logs"("createdAt");
