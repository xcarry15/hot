ALTER TABLE "articles" DROP COLUMN "tags";

ALTER TABLE "articles" ADD COLUMN "eventSubjects" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "articles" ADD COLUMN "eventAction" TEXT NOT NULL DEFAULT '';
ALTER TABLE "articles" ADD COLUMN "eventObject" TEXT NOT NULL DEFAULT '';
ALTER TABLE "articles" ADD COLUMN "eventKeyConfidence" INTEGER;

CREATE INDEX "articles_eventKey_publishedAt_idx" ON "articles"("eventKey", "publishedAt");

DELETE FROM "settings" WHERE "key" = 'ai_block_tags';
