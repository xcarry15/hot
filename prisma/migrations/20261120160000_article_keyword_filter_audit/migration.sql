-- P1-21: record the industry-title retention signal and the keyword-filter decision.
-- Historical rows keep the defaults (false / empty string) and remain interpretable
-- through their existing keywordMatched value.
ALTER TABLE "articles" ADD COLUMN "industryTitleMatched" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "articles" ADD COLUMN "keywordRetentionReason" TEXT NOT NULL DEFAULT '';
