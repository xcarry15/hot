-- 工具分类从代码常量迁移为可维护配置；工具条目继续以稳定的分类 ID 关联。
CREATE TABLE "tool_directory_categories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "tool_directory_categories_name_key" ON "tool_directory_categories"("name");
CREATE INDEX "tool_directory_categories_sortOrder_idx" ON "tool_directory_categories"("sortOrder");

INSERT INTO "tool_directory_categories" ("id", "name", "sortOrder", "updatedAt") VALUES
    ('business-support', '业务支持', 0, CURRENT_TIMESTAMP),
    ('geo-location', '地理位置', 1, CURRENT_TIMESTAMP),
    ('data-analysis', '数据分析', 2, CURRENT_TIMESTAMP),
    ('network-planning', '点位分析', 3, CURRENT_TIMESTAMP),
    ('other-tools', '其他工具', 4, CURRENT_TIMESTAMP);
