-- Add hidden flag to tool directory categories
ALTER TABLE "tool_directory_categories" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
