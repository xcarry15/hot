# CHANGELOG

## [Unreleased]
### Added
- 新增 GitHub Actions CI：自动执行 lint、TypeScript、快速回归、SQLite migration smoke 与生产构建
- 新增 GitHub Actions 生产部署和 `scripts/deploy-production.sh`，包含 SQLite 一致性备份、收敛同步、migration、构建、单实例 PM2 与健康检查
- 新增 `/api/health`，供部署后无状态存活检查
- 补齐审核、来源、维护等 Service 回归测试，并新增空库 migration/schema drift 测试

### Changed
- 统一 `typecheck`、`test:migrations`、`test:all`、`verify` 自动化入口；历史 baseline 测试改为独立手工验证入口

### Bug Fixes
- AI 分析与事件聚类服务修复 (Cursor API 不可用) (@xcarry15)
- 收敛 Event 代表、公开、推送基础门禁，并阻止已删除来源被人工强制推送
- 公开快照批量重建改为一次预取 Event，消除按 Article 查询的 N+1 开销
