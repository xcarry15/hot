DROP INDEX IF EXISTS "articles_reviewStatus_aiStatus_fetchStatus_createdAt_idx";
DROP INDEX IF EXISTS "articles_publicOverride_pinUntil_publishedAt_idx";

ALTER TABLE "articles" DROP COLUMN "reviewStatus";
ALTER TABLE "articles" DROP COLUMN "reviewReasonTags";
ALTER TABLE "articles" DROP COLUMN "reviewedAt";
ALTER TABLE "articles" DROP COLUMN "pinUntil";

CREATE INDEX "articles_publicOverride_publishedAt_idx" ON "articles"("publicOverride", "publishedAt");

DROP TABLE IF EXISTS "inbox_snapshots";

DELETE FROM "settings"
WHERE "key" IN (
  'public_important_rule',
  'public_general_rule',
  'public_irrelevant_rule',
  'public_pin_hours'
);

DELETE FROM "tuning_suggestions"
WHERE "kind" IN (
  'high_score_irrelevant',
  'low_score_important',
  'ad_misclassification',
  'wrong_brand',
  'keyword_ambiguity'
);
