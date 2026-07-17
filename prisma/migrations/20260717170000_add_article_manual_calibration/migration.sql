ALTER TABLE "articles" ADD COLUMN "aiSnapshot" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "articles" ADD COLUMN "manualOverrides" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "articles" ADD COLUMN "manualCorrectedAt" DATETIME;

UPDATE "articles"
SET "aiSnapshot" = json_object(
  'relevance', "relevance",
  'summary', "summary",
  'brand', "brand",
  'category', "category",
  'tags', "tags",
  'keyPoints', "keyPoints",
  'score', "score",
  'eventScore', "eventScore",
  'contentScore', "contentScore",
  'rawScore', "rawScore",
  'adProbability', "adProbability",
  'aiConfidence', "aiConfidence",
  'isAd', json(CASE WHEN "isAd" = 1 THEN 'true' ELSE 'false' END),
  'model', "aiModel",
  'provider', "aiProvider",
  'promptHash', "promptHash",
  'promptVersion', "promptVersion"
)
WHERE "aiStatus" = 'done';
