-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'html',
    "url" TEXT NOT NULL,
    "parserConfig" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'never_fetched',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "circuitBreakerUntil" DATETIME,
    "lastFetchedAt" DATETIME,
    "totalArticles" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);
INSERT INTO "new_sources" ("circuitBreakerUntil", "consecutiveFailures", "createdAt", "deletedAt", "enabled", "id", "lastFetchedAt", "name", "parserConfig", "status", "totalArticles", "type", "updatedAt", "url") SELECT "circuitBreakerUntil", "consecutiveFailures", "createdAt", "deletedAt", "enabled", "id", "lastFetchedAt", "name", "parserConfig", "status", "totalArticles", "type", "updatedAt", "url" FROM "sources";
DROP TABLE "sources";
ALTER TABLE "new_sources" RENAME TO "sources";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

