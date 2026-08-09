-- 工具目录只维护统一的外部链接，不再区分打开或下载类型。
-- 同时把旧标签收敛到当前标签集合，删除已经取消的推荐和下载标签。
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_tool_directory_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "href" TEXT,
    "icon" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_tool_directory_items" (
    "id", "name", "description", "category", "href", "icon", "status", "tags",
    "sortOrder", "archivedAt", "createdAt", "updatedAt"
)
SELECT
    "id", "name", "description", "category", "href", "icon", "status",
    CASE
        WHEN json_valid("tags") THEN (
            SELECT COALESCE(json_group_array("normalizedTag"), '[]')
            FROM (
                SELECT CASE value
                    WHEN 'free' THEN 'free'
                    WHEN 'popular' THEN 'popular'
                    WHEN 'new' THEN 'latest'
                END AS "normalizedTag"
                FROM json_each("tool_directory_items"."tags")
                WHERE value IN ('free', 'popular', 'new')
            )
        )
        ELSE '[]'
    END,
    "sortOrder", "archivedAt", "createdAt", "updatedAt"
FROM "tool_directory_items";

DROP TABLE "tool_directory_items";
ALTER TABLE "new_tool_directory_items" RENAME TO "tool_directory_items";

CREATE INDEX "tool_directory_items_category_archivedAt_sortOrder_idx" ON "tool_directory_items"("category", "archivedAt", "sortOrder");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
