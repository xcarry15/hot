# Hot2

Hot2 是面向餐饮/零售行业的新闻聚合、情报审核与飞书推送工具，主链路为：

```text
数据源采集 → 详情处理/关键词过滤 → 事件聚类 → AI 分析 → 情报审核 → Event 唯一推送/公开展示
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

开发地址：`http://localhost:3011`。根路径 `/` 是公开新闻卡片页，文章详情使用 `/news/[id]`；后台位于 `/admin`，当前仅包含“情报收件箱”“抓取记录”“设置”三个页面。生产环境必须在 `.env` 设置 `API_TOKEN`，首次访问后台时输入该 token 建立临时 HttpOnly 会话；Cookie 保存由 Token 派生的会话值，不直接保存可调用 API 的原始 Token，旧版原始 Token Cookie 不再兼容。公开端保持匿名访问。生产部署还应将 `NEXT_PUBLIC_SITE_URL` 设置为正式访问地址，用于 canonical、Open Graph 和 sitemap。公开导航中的“工具”“数据”目前是占位入口，暂未提供实际页面。

情报收件箱是全量文章人工校准工作台：保持左侧紧凑表格与右侧详情布局，默认展示全部文章，支持人工评分、内容判断、归类、公开策略、恢复 AI 原值、重新分析和重新抓取。Article 保留 AI 与人工校准结果；每篇文章必须先归入轻量 Event，右侧可查看同事件全部来源，并支持合并事件、拆分文章和人工指定代表文章。Event 是重复公开和重复推送的唯一门禁，同一事件新增来源不会再次推送。

抓取记录页按真实流水线展示 `采集 → 处理 → 聚类 → AI → 推送`，支持筛选待聚类、聚类失败和待复核文章，并可单独运行事件聚类阶段。聚类未完成时 AI 与推送明确显示为阻塞；URL 完全相同造成的未入库记录统一标记为“链接已存在”，不再沿用旧内容去重语义。

## 项目结构

```text
src/app/              公开页面、后台页面和 API Route Handler
src/app/admin/        Token 保护的管理后台
src/app/news/         可分享、可收录的公开文章详情页
src/app/robots.ts     robots 规则；仅公开首页和文章详情参与收录
src/app/sitemap.ts    公开首页和文章详情 sitemap
src/components/       收件箱、设置、数据源、抓取记录和公开端 UI 组件
src/features/         前端 API 客户端
src/contracts/        API、AI、文章、推送等共享契约
src/lib/              execution、pipeline、AI、推送、去重、设置等核心模块
prisma/               schema、seed、migration 历史
tests/                Vitest 测试
scripts/              migration baseline 与维护脚本
bat/                  Windows 启动、打包、部署和 Nginx 文档
db/                   本地 SQLite 数据（不进入部署包）
```

公开端以 active Event 为内容单位，每个 Event 只展示一张卡片，正文和评分取代表 Article 的最终人工校准结果，详情页同时列出其他报道来源。Article 公开规则仍负责判断代表文章是否合格，并同步 `Event.publicStatus`；`/news/[id]` 的 id 为 Event.id。浏览和原文点击仍累计到当前代表 Article，且不会污染公开内容更新时间。

## 当前架构与数据事实

- Next.js 16 App Router + React 19 + TypeScript；Prisma 6 + SQLite；单进程模块化单体，生产只运行一个 PM2 实例。
- `src/lib/execution.ts` 是唯一批量 Job 编排入口，内存互斥保证同时只有一个批量任务。Job 表的阶段、进度、错误数和 heartbeat 是任务状态事实源；停止通过 `AbortSignal` 协作式取消。
- 调度器每分钟 tick；自动抓取默认关闭。普通批量任务使用 `/api/crawl` 的 `all` 阶段，分阶段入口 `collect / process / cluster / ai / push` 仅供管理员运维。

| 阶段 | 入口代码 | 作用 |
|---|---|---|
| collect | `src/lib/pipeline/collect.ts` | 采集数据源并写入/更新文章 |
| process | `src/lib/pipeline/process.ts` | 抓取详情、提取正文、关键词过滤；不同 URL 的重复文章保留并标记 |
| cluster | `src/lib/pipeline/cluster.ts` | 将已处理 Article 归入 Event，记录失败重试与待复核状态 |
| ai | `src/lib/pipeline/analyze.ts` | 写入摘要、标签、评分和审计字段 |
| push | `src/lib/pipeline/push-bridge.ts` | 按统一条件投递未推送文章 |

关键 API 约束：`POST /api/crawl` 是批量任务的主入口；`GET /api/dashboard/analytics` 提供按周期和数据源聚合的内容质量分析；`POST /api/sources/retry` 只重试数据源采集；`POST /api/push` 只推送单篇文章；`GET /api/crawl-log/status` 是抓取记录页唯一任务快照来源；`POST /api/worker/stop` 停止当前任务；`POST /api/articles/review` 处理收件箱归类；`GET/POST /api/feedback` 处理调优建议。Route Handler 只做适配，事务和业务规则由 Service 负责。不要新增并行的批量编排入口、独立队列或绕过 `src/lib/execution.ts` 的后台任务；历史兼容目录即使存在，也不应作为新功能入口。

`InboxSnapshot` 保存近 90 天的待归类积压快照，概览以此展示积压趋势；快照是派生指标，不改变文章流水线事实。

`Job`、`FetchLog`、`PushLog`、`DiscardedItem` 和 `EventClusterAudit` 分别记录任务、采集、事件目标级推送、未入库条目和聚类/人工纠错事实。`Article` 记录全文、AI 与人工校准、归类和事件归属；`Event` 记录代表文章、来源数量、公开状态和唯一推送状态。PushLog 关联 Event，并保存投递时的代表 Article；历史展示与来源统计使用该发送时快照，不跟随当前代表文章变化。未配置可用 Webhook 时，批量推送直接跳过，不为每个 Event 重复写失败日志。

设置默认值、校验、敏感性和导出策略集中在 `src/lib/settings-catalog.ts`；AI Provider 定义在 `src/contracts/ai-provider.ts`。事件聚类规则集中在 `src/contracts/event-clustering.ts`：只比较最近 7 天 active Event，内容指纹或标准化标题完全一致时直接归入，规则证据不足时调用 AI，仍不确定则保守新建并标记复核。第一版不引入 Embedding。

AI 重置由 `src/lib/article-ai-reset.ts` 中的重置 helper 统一生成，重新分析继续保留人工覆盖。旧 Article duplicate 状态和“取消重复并分析”入口已经删除；内容指纹只作为 Event 聚类证据。

公开端保持自动发布：AI 完成、来源允许公开并满足评分/软文规则后进入公开快照；后台可人工修正摘要、品牌、分类、标签和关键点，并对单篇立即公开、隐藏或恢复自动规则。收件箱支持组合筛选与“需要人工介入”视图；采用未命中候选词时最多恢复 50 条对应记录并交回现有处理流水线。

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

日常运维：`npm run db:migrate:status`、`npm run db:cleanup-logs`、`npm run db:rebuild-public`、`pm2 status`、`pm2 logs h2-hot2`。日志保留周期由 `src/lib/log-retention.ts` 统一负责：FetchLog 30 天，PushLog 90 天但保留未完成全部投递的记录，已完成/失败 Job 30 天；不会删除 Article、Source、DiscardedItem 或 pending/running Job。`db:reset`、`db:push` 仅限明确的本地重建或应急场景。

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
