-- Source.totalArticles and Article.pushUrgency are derived values.
-- Rebuilds are not needed for the current SQLite version; both columns are
-- independent scalar fields without indexes or foreign-key dependencies.
ALTER TABLE "sources" DROP COLUMN "totalArticles";
ALTER TABLE "articles" DROP COLUMN "pushUrgency";

-- Legacy global AI keys are no longer part of the settings catalog.
DELETE FROM "settings"
WHERE "key" IN ('ai_api_key', 'ai_base_url', 'ai_model');
