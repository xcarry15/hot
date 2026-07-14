# Hot2 项目协作说明

行业新闻聚合与飞书推送器：数据源采集 → 去重/过滤 → AI 分析 → 飞书多 Webhook 推送。

> 当前代码事实以根目录 [`项目当前架构基线.md`](项目当前架构基线.md) 为准；本文件只保留协作约束和常用索引，`README.md` 负责快速开始，`bat/部署和更新方法.txt` 负责发布运维。历史审查与执行计划不作为当前实现说明。

## 技术与运行模型

- Next.js 16 App Router + React 19 + TypeScript
- Node.js 20+
- Prisma 6 + SQLite
- 单进程模块化单体；生产 PM2 只运行一个实例
- Scheduler 每分钟 tick，任务直接在同一进程内执行
- 同一时刻只允许一个后台 Job 修改流水线状态
- 页面以 `/api/crawl-log/status` 的 Job 数据库快照轮询恢复状态

## 常用命令

| 任务 | 命令 |
|---|---|
| 开发 | `npm run dev` |
| 构建 | `npm run build` |
| 生产启动 | `npm run start` |
| Lint | `npm run lint` |
| 测试 | `npm test` |
| 生成 Prisma Client | `npm run db:generate` |
| 本地生成/应用 migration | `npm run db:migrate` |
| 生产应用 migration | `npm run db:migrate:deploy` |
| 查看 migration 状态 | `npm run db:migrate:status` |
| 存量库首次接入 migration | `npm run db:migrate:baseline`（只执行一次） |
| 初始化默认数据 | `npm run db:seed` |
| 清理历史日志 | `npm run db:cleanup-logs` |
| 清理旧设置键 | `npm run db:cleanup-legacy`（开发/维护脚本，部署包不依赖） |

`npm run db:push` 和 `npm run db:reset` 仅限明确的本地应急/重建场景；生产日常更新不得使用，也不得用它们替代 migration。

## 核心数据流

```text
Scheduler / API
      ↓
runJob（全局单 Job + AbortController）
      ↓
collect → process → ai → push
      ↓
Source / Article / Job / FetchLog / PushLog / DiscardedItem
```

- `src/lib/parser-registry.ts`：解析器注册表，支持 `html`、`rss`、`websearch`、`canyin88`；未知类型直接拒绝。
- `src/lib/source-schema.ts`：Source 创建、更新、测试的输入契约。
- `src/lib/source-config.ts`：`parserConfig` 在 API 边界统一为单层 JSON 对象字符串。
- 采集、详情处理、AI 位于 `src/lib/pipeline/*`，推送位于 `src/lib/push/*`，Job 编排由 `execution.ts` 持有。
- `src/lib/article-pipeline-status.ts`：Article 流水线状态集中投影。
- `src/lib/job-progress.ts`：Job 阶段、进度、错误数和 heartbeat 写入。
- `src/components/crawl-log/use-crawl-log-snapshot.ts`：前端唯一任务快照来源，定时轮询 Job 事实。
- `src/lib/settings-catalog.ts`：设置 key、默认值、校验、敏感性、导出和前端默认值的单一描述表。
- `src/lib/push/*`：策略、候选查询、批量投递、卡片和 transport。`PushLog(articleId + webhookUrl + success)` 是目标级成功事实，部分失败重试只发送未成功 URL，不引入 `PushDelivery` 表。
- `src/lib/log-retention.ts`：FetchLog、已完整推送 Article 的 PushLog、已结束 Job 的保留策略。
- `项目当前架构基线.md`：当前 API 入口、默认值、数据事实、详情组件边界和防漂移规则的唯一基线。

## Job 与状态约束

- `runJob()` 先占用全局执行槽，再创建 Job；创建失败必须释放槽位。
- 停止是协作式取消：AbortSignal 贯穿 HTTP、解析器、AI、Webhook 和退避等待；迟到结果不得写库。
- `Job` 的 `currentStage/progressTotal/progressDone/progressErrors/currentItemLabel/heartbeatAt` 是任务状态事实源。
- `activeJob/latestJob` 和 Article 状态由 `/api/crawl-log/status` 同步返回；前端不再从 `sessionStorage` 或乐观步骤推断任务状态。
- `resetOrphanedJobs()` 只处理进程崩溃遗留的 running Job，不代表正常停止流程。

## 数据库与发布

当前 migration 链和数据库事实见 `项目当前架构基线.md`；部署包自带 `prisma/migrations/`，由 `npm run db:migrate:deploy` 自动按序应用，避免在多个文档复制清单。

生产发布流程：停止 PM2 → 备份存量 SQLite → `npm run db:migrate:deploy` → `npm run build` → 删除并重新启动 PM2。首次把历史 `db push` 数据库接入 migration 时，先执行 `db:migrate:baseline`，具体步骤见 `bat/部署和更新方法.txt`。

日志保留周期：FetchLog 30 天；PushLog 90 天，但未完成全部目标投递的 Article 日志保留；completed/failed Job 30 天。清理命令不会删除 Article、Source、DiscardedItem，也不会删除 pending/running Job。

## API 鉴权

- 开发环境未设置 `API_TOKEN` 时放行 API。
- 生产环境必须配置 `API_TOKEN`；所有 API（含 GET）均需 `Authorization: Bearer <API_TOKEN>`。
- GET 设置会脱敏 API key 和 Webhook；设置导出为受保护的 POST 端点，明文仅用于备份/迁移。
- 浏览器 token 存在当前浏览器 `localStorage['api_token']`，由请求 helper 在 API 边界显式注入请求头。

## 目录

```text
src/app/              页面和 API Route Handler
src/components/       页面、设置、Source、抓取记录和 UI 组件
src/lib/              execution / pipeline / ai / push / dedup / settings 等核心模块
prisma/               schema、seed、migration 历史
scripts/              baseline 与日志维护脚本
tests/                Vitest 测试
bat/                  Windows 打包脚本、部署说明、Nginx 配置模板
db/                   本地 SQLite 数据（不进入部署包）
```

## 协作边界

- 保持 Next.js 单进程架构，不引入 Redis、BullMQ、独立 worker、通用 Repository 或事件溯源。
- 修改 `prisma/schema.prisma` 前必须同时设计 migration、存量库备份/部署和回滚方案；禁止 reset 用户数据库。
- 一次只处理一个重构待办；先补对应测试，再做最小改动。
- 不要为了拆文件、换状态库或清理依赖而顺手扩大范围。
