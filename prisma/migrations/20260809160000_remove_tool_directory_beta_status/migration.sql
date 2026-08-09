-- “内测中”与“即将上线”合并，存量工具统一收敛为“即将上线”。
UPDATE "tool_directory_items"
SET "status" = 'coming_soon', "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'beta';
