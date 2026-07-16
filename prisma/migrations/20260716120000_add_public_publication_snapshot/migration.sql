ALTER TABLE "articles" ADD COLUMN "publicStatus" TEXT NOT NULL DEFAULT 'unpublished';
ALTER TABLE "articles" ADD COLUMN "publicPublishedAt" DATETIME;
ALTER TABLE "articles" ADD COLUMN "publicRevokedAt" DATETIME;
ALTER TABLE "articles" ADD COLUMN "publicPublicationReason" TEXT NOT NULL DEFAULT '';
ALTER TABLE "articles" ADD COLUMN "publicPublicationEvaluatedAt" DATETIME;

UPDATE "articles"
SET
  "publicStatus" = CASE
    WHEN "aiStatus" = 'done'
      AND "publicOverride" IN ('public', 'auto')
      AND ("publicOverride" = 'public' OR "score" >= CAST(COALESCE((SELECT "value" FROM "settings" WHERE "key" = 'public_min_score'), '70') AS INTEGER))
      AND (COALESCE((SELECT "value" FROM "settings" WHERE "key" = 'public_hide_ads'), 'true') <> 'true' OR "publicOverride" = 'public' OR "isAd" = 0)
      AND EXISTS (
        SELECT 1 FROM "sources" s
        WHERE s."id" = "articles"."sourceId"
          AND s."deletedAt" IS NULL
          AND s."publicEnabled" = 1
      )
    THEN 'published'
    ELSE 'unpublished'
  END,
  "publicPublishedAt" = CASE
    WHEN "aiStatus" = 'done'
      AND "publicOverride" IN ('public', 'auto')
      AND ("publicOverride" = 'public' OR "score" >= CAST(COALESCE((SELECT "value" FROM "settings" WHERE "key" = 'public_min_score'), '70') AS INTEGER))
      AND (COALESCE((SELECT "value" FROM "settings" WHERE "key" = 'public_hide_ads'), 'true') <> 'true' OR "publicOverride" = 'public' OR "isAd" = 0)
      AND EXISTS (
        SELECT 1 FROM "sources" s
        WHERE s."id" = "articles"."sourceId"
          AND s."deletedAt" IS NULL
          AND s."publicEnabled" = 1
      )
    THEN COALESCE("publishedAt", "createdAt")
    ELSE NULL
  END,
  "publicPublicationReason" = 'initial-backfill',
  "publicPublicationEvaluatedAt" = CURRENT_TIMESTAMP;

CREATE INDEX "articles_publicStatus_publishedAt_idx" ON "articles"("publicStatus", "publishedAt");
