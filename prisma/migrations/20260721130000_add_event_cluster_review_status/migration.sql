ALTER TABLE "events" ADD COLUMN "clusterReviewStatus" TEXT NOT NULL DEFAULT 'confirmed';

UPDATE "events"
SET "clusterReviewStatus" = 'pending'
WHERE "id" IN (
  SELECT DISTINCT "eventId"
  FROM "articles"
  WHERE "eventId" IS NOT NULL AND "clusterStatus" = 'needs_review'
);

UPDATE "events"
SET
  "representativeArticleId" = NULL,
  "representativeManual" = 0,
  "publicStatus" = CASE WHEN "publicStatus" = 'published' THEN 'revoked' ELSE 'unpublished' END,
  "publicRevokedAt" = CASE WHEN "publicStatus" = 'published' THEN CURRENT_TIMESTAMP ELSE NULL END,
  "publicDateKey" = '',
  "publicSortAt" = NULL
WHERE "clusterReviewStatus" = 'pending';

UPDATE "articles"
SET
  "publicStatus" = 'unpublished',
  "publicPublishedAt" = NULL,
  "publicRevokedAt" = NULL,
  "publicPublicationReason" = 'event-not-ready',
  "publicPublicationEvaluatedAt" = CURRENT_TIMESTAMP,
  "publicContentUpdatedAt" = NULL
WHERE "eventId" IN (
  SELECT "id" FROM "events" WHERE "clusterReviewStatus" = 'pending'
);

DROP INDEX "events_status_lastSeenAt_idx";

CREATE INDEX "events_status_clusterReviewStatus_lastSeenAt_idx"
ON "events"("status", "clusterReviewStatus", "lastSeenAt");
