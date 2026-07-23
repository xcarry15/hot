-- 仅补充上一版默认广告块；管理员自定义内容不覆盖。
UPDATE "settings"
SET "value" = replace(
  "value",
  '- 公益捐赠、救灾、辟谣、事故通报不因品牌发布而自动算广告',
  '- 公益捐赠、救灾、辟谣、事故通报不因品牌发布而自动算广告
- 员工福利、劳动保障、五险一金、保险或用工制度等可核验企业动作，若核心是报道事实及行业影响，不算广告；只有借此夸品牌且缺少独立事实时才算广告'
)
WHERE "key" = 'ai_block_ad'
  AND instr("value", '公益捐赠、救灾、辟谣、事故通报不因品牌发布而自动算广告') > 0
  AND instr("value", '员工福利、劳动保障、五险一金') = 0;

-- 聚类阈值需要在设置页可见且可立即修改；老库缺行时补默认值。
INSERT OR IGNORE INTO "settings" ("id", "key", "value", "createdAt", "updatedAt")
VALUES ('seed_event_cluster_ai_same_event_confidence', 'event_cluster_ai_same_event_confidence', '70', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO "settings" ("id", "key", "value", "createdAt", "updatedAt")
VALUES ('seed_event_cluster_ai_different_event_confidence', 'event_cluster_ai_different_event_confidence', '85', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
