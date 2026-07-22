# CHANGELOG

## [Unreleased]
### Bug Fixes
- AI 分析与事件聚类服务修复 (Cursor API 不可用) (@xcarry15)
- 收敛 Event 代表、公开、推送基础门禁，并阻止已删除来源被人工强制推送
- 公开快照批量重建改为一次预取 Event，消除按 Article 查询的 N+1 开销
