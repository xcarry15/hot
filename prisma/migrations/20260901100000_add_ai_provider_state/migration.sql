-- 持久化 Provider 级 AI 冷却与退避状态。
CREATE TABLE "ai_provider_states" (
    "provider" TEXT NOT NULL PRIMARY KEY,
    "cooldownUntil" DATETIME,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorKind" TEXT NOT NULL DEFAULT '',
    "lastStatus" INTEGER,
    "lastRetryAfterMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
