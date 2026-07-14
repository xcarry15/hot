# Hot2

Hot2 是面向餐饮/零售行业的新闻聚合与飞书推送工具，主链路为：

```text
数据源采集 → 详情处理 → 去重/关键词过滤 → AI 分析 → 条件推送
```

## 快速开始

环境要求：Node.js 20+、npm。

```bash
npm install
copy .env.example .env       # Windows；Linux/macOS 使用 cp
npm run db:migrate:deploy
npm run db:generate
npm run db:seed
npm run dev
```

开发地址：`http://localhost:3011`。生产环境必须在 `.env` 设置 `API_TOKEN`；浏览器进入「设置 → 账户」填写同一个 token 后，才能访问或修改 API 数据。

## 项目结构

```text
src/app/              页面和 API Route Handler
src/components/       页面、设置、数据源、抓取记录和 UI 组件
src/features/         前端 API 客户端
src/contracts/        API、AI、文章、推送等共享契约
src/lib/              execution、pipeline、AI、推送、去重、设置等核心模块
prisma/               schema、seed、migration 历史
tests/                Vitest 测试
scripts/              migration baseline 与维护脚本
bat/                  Windows 启动、打包、部署和 Nginx 文档
db/                   本地 SQLite 数据（不进入部署包）
```

## 当前架构与数据事实

- Next.js 16 App Router + React 19 + TypeScript；Prisma 6 + SQLite；单进程模块化单体，生产只运行一个 PM2 实例。
- `src/lib/execution.ts` 是唯一批量 Job 编排入口，内存互斥保证同时只有一个批量任务。Job 表的阶段、进度、错误数和 heartbeat 是任务状态事实源；停止通过 `AbortSignal` 协作式取消。
- 调度器每分钟 tick；自动抓取默认关闭。普通批量任务使用 `/api/crawl` 的 `all` 阶段，分阶段入口 `collect / process / ai / push` 仅供管理员运维。

| 阶段 | 入口代码 | 作用 |
|---|---|---|
| collect | `src/lib/pipeline/collect.ts` | 采集数据源并写入/更新文章 |
| process | `src/lib/pipeline/process.ts` | 抓取详情、提取正文、过滤和去重 |
| ai | `src/lib/pipeline/analyze.ts` | 写入摘要、标签、评分和审计字段 |
| push | `src/lib/pipeline/push-bridge.ts` | 按统一条件投递未推送文章 |

关键 API 约束：`POST /api/crawl` 是唯一批量任务入口；`POST /api/sources/retry` 只重试数据源采集；`POST /api/push` 只推送单篇文章；`GET /api/crawl-log/status` 是抓取记录页唯一任务快照来源；`POST /api/worker/stop` 停止当前任务。Route Handler 只做适配，事务和业务规则由 Service 负责。不得重新引入已移除的 `/api/jobs`、`/api/articles/refetch-batch` 或独立队列。

`Job`、`FetchLog`、`PushLog`、`DiscardedItem` 和 `DiscardedRetryAudit` 分别记录任务、采集、目标级推送、未入库条目和管理员重试事实。页面不得用 `sessionStorage` 或乐观步骤推断任务状态；抓取记录使用 Job snapshot。列表接口返回摘要投影，详情接口才返回正文、评分明细、去重证据和脱敏推送日志。

设置默认值、校验、敏感性和导出策略集中在 `src/lib/settings-catalog.ts`；AI Provider 定义在 `src/contracts/ai-provider.ts`；预设数据源定义在 `src/lib/preset-sources.ts`。Webhook 默认值为空数组，仓库不得保存真实 Webhook。当前去重规则唯一来源是 `src/contracts/dedup-settings.ts`：时间窗口 15 天、特定数字最少重叠数 2、正文 LCS 单段 40 字符、总长 160 字符、品牌门控开启、短文兜底 1000 字符。标题 Jaccard 仅作证据，不单独触发去重。

## 数据库与生产部署

项目按 Prisma migration 发布，不使用 `prisma db push` 作为日常部署方式。当前 migration 按序位于 `prisma/migrations/`，生产由 `npm run db:migrate:deploy` 自动应用。历史 `db push` 库首次切换前必须停服务并备份：

```bash
npm run db:migrate:baseline
npm run db:migrate:deploy
npm run db:migrate:status
```

出现 drift 必须停止并人工检查，不要 reset 或覆盖数据库。生产更新顺序：停止 PM2 → 备份 SQLite → `npm run db:migrate:deploy` → `npm run db:generate` → `npm run build` → 重启 PM2。

```bash
npm install
npm run db:migrate:deploy
npm run db:generate
npm run build
pm2 delete h2-hot2 && pm2 start npm --name h2-hot2 -- start
```

日常运维：`npm run db:migrate:status`、`npm run db:cleanup-logs`、`pm2 status`、`pm2 logs h2-hot2`。日志保留周期由 `src/lib/log-retention.ts` 统一负责：FetchLog 30 天，PushLog 90 天但保留未完成全部投递的记录，已完成/失败 Job 30 天；不会删除 Article、Source、DiscardedItem 或 pending/running Job。`db:reset`、`db:push` 仅限明确的本地重建或应急场景。

## 开发、验证与防漂移规则

```bash
npm run dev
npm run lint
npx tsc --noEmit
npm test                         # 排除 db-baseline
npm run test:critical
npm run test:all
npm run build
```

新增业务入口前先检查是否可归入现有 Route/Service；默认值只维护在对应目录；数据库字段变更必须同时提交 schema、migration、存量库 baseline 兼容处理和发布说明；API 新字段必须同步 DTO、序列化函数和消费者，不得直接把 Prisma model 返回浏览器。修改设置、Provider 或去重规则时同步契约、校验、UI 和测试。逻辑变更应补充对应 Vitest 回归测试。

## 安全与发布文件

不要提交 `.env`、API key、Webhook URL、SQLite 数据或部署压缩包。部署包不包含 `.env`、`db/`、测试和根目录开发说明；`bat/` 中的部署/Nginx 文档会随包保留。完整现场流程见 `bat/部署和更新方法.txt`，Nginx 模板见 `bat/本项目的nginx.txt`。
