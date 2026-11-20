# 更新日志

## [未发布]

### 安全与运行基线

- 会话签名密钥与 `API_TOKEN` 解耦：新增独立 `SESSION_SECRET`，配置后 API Token 不再能伪造后台会话 Cookie；未配置时保持旧部署兼容。
- 敏感端点 `POST /api/settings/reveal` 增加路由层显式鉴权（纵深防御），不再单点依赖 proxy matcher。
- 开发环境补齐 `SETTINGS_ENCRYPTION_KEY`、`SESSION_SECRET`、`VISIT_GEOIP_DB`；加密设置改用独立密钥重加密，避免依赖数据库路径派生值。
- 开发库应用 3 个待迁移（访问统计、AI 调用指标、移除旧搜索索引），sources 启用状态与线上对齐。

### 地区统计

- 访问地区解析增加进程内缓存与降级可观测日志，降低逐请求 `mmdblookup` 开销；仅在显式配置本地 mmdb 时解析，不向外部服务发送 IP。

### 文档与维护

- 校正 AI Provider 退避、模型协议和平台额度说明，补齐文章价值分类术语。
- 移除重复的 VBS 打包启动器，保留 `bat/run.bat` 入口。
- 更新代码质量审计范围说明，避免过期计数被误读为当前结论。

### 稳定性与数据一致性（全量技术债修复）

- SQLite 并发写事务改为全局串行队列 + 瞬态冲突重试，消除线上持续的 P1008 / P2028 / Transaction already closed；嵌套事务透传避免自锁。
- 流水线取消/租约丢失后不再在补偿阶段写库或真实推送；cluster 的 `forceRetry` 保留本 Job 退避；租约续期失败时 Job 条件重新入队。
- `technical-status` 纳入独占写门禁与路由层鉴权，带请求体上限；关键词过滤决策新增 `industryTitleMatched` / `keywordRetentionReason` 落库字段与 migration，Excel 导出增列、格式版本升至 6。

### 安全

- 敏感设置 envelope 增加 keyId + AAD 按字段绑定，兼容旧格式；新增 `npm run settings:rotate-key` 原子轮换工具（默认 dry-run）；启动时自检密文可解密，失败 fail-fast。
- 路由层 `requireAdminAuth` 覆盖全部 54 个受保护路由；备份导出加 HMAC 签名；请求体增加大小上限与超时区分 408/413；代理路径补齐 SSRF 校验。
- 生产依赖升级：`xlsx` 换官方 CDN 0.20.3，`next`/`undici`/`zod`/`effect` 升级，生产 audit 高危漏洞清零。

### 发布与运维

- 发布脚本备份做 `integrity_check` 校验、回滚前停 PM2、migration 预检改为严格前缀（允许待应用的新迁移）、reset 需显式确认；CI 手动部署路径补齐全套门禁。
- 新增 PM2 日志轮转配置与 rawContent 手动归档脚本（默认 dry-run）；校正 `AGENTS.md` 的 reset 备份说明。

## 2026-11-12

- feat: 重设计访问统计分析页面；完善访问统计与浏览排行。
- perf: 优化任务状态刷新与耗时记录。

## 2026-11-10

- feat: 接入硅基流动模型。
- feat: 添加 36 氪消费信息源。

## 2026-11-09

- feat: 新增访问统计看板。
- fix: 优化标题去重与推送防重。

## 2026-10-26

- fix: 免费模型检测支持冷却续测和进度保存。

## 2026-10-25

- fix: 升级框架并移除 OpenCode，优化公开页面性能。

## 2026-10-21

- feat: 接入 Google Gemini 模型。

## 2026-10-20

- fix: 收敛模型目录选择分支。
- feat: 更新 DeepSeek 默认模型并自动同步官方目录。

## 2026-10-08

### 修复

- 统一任务中心与工作台搜索侧栏的异常分类计数口径，改善文章处理期间的状态反馈。
- 收紧正文提取边界与事件归并条件，减少模板内容混入和不同事件误合并。
- 补齐后台列表加载失败状态与重试入口。
