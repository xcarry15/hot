ALTER TABLE "articles" ADD COLUMN "publicContentUpdatedAt" DATETIME;

-- SQLite 不允许 ALTER TABLE 添加 CURRENT_TIMESTAMP 默认值；一次性初始化即可。
UPDATE "articles" SET "publicContentUpdatedAt" = CURRENT_TIMESTAMP;

CREATE INDEX "articles_publicStatus_publicContentUpdatedAt_idx"
ON "articles"("publicStatus", "publicContentUpdatedAt");
