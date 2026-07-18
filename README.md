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

情报收件箱是全量文章人工校准工作台：左侧直接显示流程、聚类状态、来源数和代表文章，并提供待归类、聚类待复核、低置信度、多来源、代表文章和人工修正视图；右侧集中处理评分、内容、公开策略、聚类依据、成员移动、独立成新事件、事件合并和代表文章。`articleId + panel=cluster/content` 可精确定位文章和校准区。主动重新生成统一提交持久化单篇 Job。Article 保留 AI 与人工校准结果，Event 是公开和推送的唯一门禁。

抓取记录页按真实流水线展示 `采集 → 处理 → 聚类 → AI → 推送`，负责 Job 监控和技术恢复。当前任务区展示任务范围、目标文章或数据源、阶段队列、当前阶段、完成数、百分比和错误数；项目使用全局单 Job 模型，不伪造多任务等待队列。每篇文章只暴露当前失败步骤的原位恢复操作；单篇 Job 会在快照中携带目标 Article 和当前阶段，使对应步骤在任务整个运行期间持续显示加载状态。AI 分析完成的文章会在标题前显示最终有效评分，流程诊断会复用收件箱的内容字段展示 AI 洞察和最多 5 条核心要点，但不传输评分明细、软文、置信度或分类等其他内容质量字段；“去聚类复核”和“查看内容”分别深链到收件箱对应面板。推送失败只投影到 Event 当前代表 Article，非代表成员显示为不适用。

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

关键 API 约束：`POST /api/crawl` 是批量任务主入口；`POST /api/articles/[id]/workflow` 是单篇处理、聚类、AI 和普通推送恢复/重跑的唯一入口，其中 `retry` 只允许当前可恢复失败步骤，`regenerate` 会按起点重置并重算，且不能用于完整重推。推送服务使用 `normal`、`retry_failed`、`repush_all` 三种明确模式：流水线普通推送、最新失败目标恢复、Event 级完整重推。`GET /api/crawl-log/status` 与 `GET /api/admin/work-queue-summary` 共同复用唯一技术待办事实源；推送失败只映射到代表 Article，并按当前启用目标的最新 PushLog 判断。旧 `/api/articles/refetch`、`/api/articles/reprocess` 和 Article 级 `/api/push` 已删除。Route Handler 只做适配，事务和业务规则由 Service 负责。

`InboxSnapshot` 保存近 90 天的待归类积压快照，概览以此展示积压趋势；快照是派生指标，不改变文章流水线事实。

`Job`、`FetchLog`、`PushLog`、`DiscardedItem` 和 `EventClusterAudit` 分别记录任务、采集、事件目标级推送、未入库条目和聚类/人工纠错事实。`Article` 记录全文、AI 与人工校准、归类和事件归属；`Event` 记录代表文章、来源数量、公开状态和唯一推送状态。PushLog 关联 Event，并保存投递时的代表 Article；历史展示与来源统计使用该发送时快照，不跟随当前代表文章变化。未配置可用 Webhook 时，批量推送直接跳过，不为每个 Event 重复写失败日志。

设置默认值、校验、敏感性和导出策略集中在 `src/lib/settings-catalog.ts`；AI Provider 定义在 `src/contracts/ai-provider.ts`。事件聚类规则集中在 `src/contracts/event-clustering.ts`：只比较最近 7 天 active Event，内容指纹或标准化标题完全一致时直接归入，规则证据不足时调用 AI，仍不确定则保守新建并标记复核。`needs_review` 允许继续 AI，但禁止公开和推送，必须人工确认独立或移动到正确 Event。第一版不引入 Embedding。

AI 重置由 `src/lib/article-ai-reset.ts` 中的重置 helper 统一生成，重新分析继续保留人工覆盖。旧 Article duplicate 状态和“取消重复并分析”入口已经删除；内容指纹只作为 Event 聚类证据。

公开端保持自动发布：只有代表 Article 已完成聚类（`clusterStatus=clustered`）、AI 完成、来源允许公开并满足评分/软文规则时才进入公开快照；`pending`、`failed`、`needs_review` 均不得公开或推送。后台可人工修正摘要、品牌、分类、标签、关键点和评分，并对单篇设置公开、隐藏或恢复自动规则。收件箱使用人工待处理视图，不把抓取、聚类、AI 或推送技术失败混入人工队列。

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

新增业务入口前先检查是否可归入现有 Route/Service；默认值只维护在对应目录；数据库字段变更必须同时提交 schema、migration 和发布说明。当前业务数据按重新采集处理，不为旧 Article/Event 数据增加双读、回填或兼容分支。API 新字段必须同步 DTO、序列化函数和消费者，不得直接把 Prisma model 返回浏览器。修改设置、Provider、聚类或去重规则时同步契约、校验、UI、README 和相关实施文档。逻辑变更应补充对应 Vitest 回归测试。

## 安全与发布文件

不要提交 `.env`、API key、Webhook URL、SQLite 数据或部署压缩包。部署包不包含 `.env`、`db/`、测试和根目录开发说明；`bat/` 中的部署/Nginx 文档会随包保留。完整现场流程见 `bat/部署和更新方法.txt`，Nginx 模板见 `bat/本项目的nginx.txt`。
