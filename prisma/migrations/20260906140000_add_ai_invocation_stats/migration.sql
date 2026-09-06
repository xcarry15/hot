-- 文章 AI 请求运行指标；不保存提示词、正文或响应内容。
CREATE TABLE "ai_invocations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "articleId" TEXT,
    "jobId" TEXT,
    "operation" TEXT NOT NULL DEFAULT 'article_analysis',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorKind" TEXT NOT NULL DEFAULT '',
    "statusCode" INTEGER,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_invocations_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ai_invocations_createdAt_idx" ON "ai_invocations"("createdAt");
CREATE INDEX "ai_invocations_operation_createdAt_idx" ON "ai_invocations"("operation", "createdAt");
CREATE INDEX "ai_invocations_provider_model_createdAt_idx" ON "ai_invocations"("provider", "model", "createdAt");
CREATE INDEX "ai_invocations_articleId_createdAt_idx" ON "ai_invocations"("articleId", "createdAt");
