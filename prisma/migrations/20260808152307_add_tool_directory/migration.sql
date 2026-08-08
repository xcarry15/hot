-- CreateTable
CREATE TABLE "tool_directory_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "href" TEXT,
    "icon" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'open',
    "status" TEXT NOT NULL DEFAULT 'active',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "tool_directory_items_category_archivedAt_sortOrder_idx" ON "tool_directory_items"("category", "archivedAt", "sortOrder");
