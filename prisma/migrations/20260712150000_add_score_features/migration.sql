ALTER TABLE "articles" ADD COLUMN "eventScore" INTEGER;
ALTER TABLE "articles" ADD COLUMN "contentScore" INTEGER;
ALTER TABLE "articles" ADD COLUMN "rawScore" INTEGER;
ALTER TABLE "articles" ADD COLUMN "adProbability" INTEGER;
ALTER TABLE "articles" ADD COLUMN "aiConfidence" INTEGER;
ALTER TABLE "articles" ADD COLUMN "scorePolicyVersion" TEXT NOT NULL DEFAULT '';
ALTER TABLE "articles" ADD COLUMN "aiModel" TEXT NOT NULL DEFAULT '';
