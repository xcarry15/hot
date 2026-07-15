-- Existing versions stored duplicate evidence only in skipReason/dedupDetail.
-- Surface those historical articles in the intelligence inbox after the new flag is added.
UPDATE "articles"
SET "duplicateStatus" = 'duplicate'
WHERE "duplicateStatus" = 'none'
  AND "aiStatus" = 'skipped'
  AND "skipReason" LIKE '[重复]%';
