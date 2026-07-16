# Hot2

Hot2 是面向餐饮/零售行业的新闻聚合、情报审核与飞书推送工具，主链路为：

```text
数据源采集 → 详情处理 → 去重/关键词过滤 → AI 分析 → 情报审核 → 条件推送/公开展示
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

公开端只展示 AI 分析完成且符合「设置 → 公开」规则的文章，支持关键词筛选；默认展示最近 3 个有文章的日期，搜索结果默认展示最近 10 个匹配日期，之后按日期游标每次加载更早 3 个日期，同一天的文章始终完整展示。规则包含自动最低评分、数据源公开开关和软文处理；人工重要归类强制公开并置顶，一般/无关归类按映射执行。公开可见性写入 `Article.publicStatus` 持久化发布快照，公开列表和详情只按已发布状态读取；评分、软文规则、人工覆盖、AI 状态或数据源开关变化时由服务同步快照，避免每次公开请求重算规则。`Article.publicContentUpdatedAt` 单独记录公开内容更新时间，浏览量和原文点击量不会污染 sitemap 的 `lastModified`。若需人工修复快照，可运行 `npm run db:rebuild-public`。公开读取接口为 `/api/public/articles`，与需要 Token 的管理 API 分离；筛选页、后台和 API 均不参与搜索引擎收录，首页和文章详情页参与收录。文章详情累计浏览量和原文点击量，浏览量采用短暂内存聚合后批量写入 SQLite，指标在后台概览与文章详情中展示。

## 当前架构与数据事实

- Next.js 16 App Router + React 19 + TypeScript；Prisma 6 + SQLite；单进程模块化单体，生产只运行一个 PM2 实例。
- `src/lib/execution.ts` 是唯一批量 Job 编排入口，内存互斥保证同时只有一个批量任务。Job 表的阶段、进度、错误数和 heartbeat 是任务状态事实源；停止通过 `AbortSignal` 协作式取消。
- 调度器每分钟 tick；自动抓取默认关闭。普通批量任务使用 `/api/crawl` 的 `all` 阶段，分阶段入口 `collect / process / ai / push` 仅供管理员运维。

| 阶段 | 入口代码 | 作用 |
|---|---|---|
| collect | `src/lib/pipeline/collect.ts` | 采集数据源并写入/更新文章 |
| process | `src/lib/pipeline/process.ts` | 抓取详情、提取正文、关键词过滤；不同 URL 的重复文章保留并标记 |
| ai | `src/lib/pipeline/analyze.ts` | 写入摘要、标签、评分和审计字段 |
| push | `src/lib/pipeline/push-bridge.ts` | 按统一条件投递未推送文章 |

关键 API 约束：`POST /api/crawl` 是批量任务的主入口；`GET /api/dashboard/analytics` 提供按周期和数据源聚合的内容质量分析；`POST /api/sources/retry` 只重试数据源采集；`POST /api/push` 只推送单篇文章；`GET /api/crawl-log/status` 是抓取记录页唯一任务快照来源；`POST /api/worker/stop` 停止当前任务；`POST /api/articles/review` 处理收件箱归类；`GET/POST /api/feedback` 处理调优建议。Route Handler 只做适配，事务和业务规则由 Service 负责。不要新增并行的批量编排入口、独立队列或绕过 `src/lib/execution.ts` 的后台任务；历史兼容目录即使存在，也不应作为新功能入口。

`InboxSnapshot` 保存近 90 天的待归类积压快照，概览以此展示积压趋势；快照是派生指标，不改变文章流水线事实。

`Job`、`FetchLog`、`PushLog`、`DiscardedItem` 和 `DiscardedRetryAudit` 分别记录任务、采集、目标级推送、未入库条目和管理员重试事实。`Article` 还记录收件箱归类、预设反馈标签、公开覆盖、置顶、重复证据和浏览/点击计数；`KeywordCandidate` 保存未命中标题生成的本地候选词，`TuningSuggestion` 保存待管理员确认的调优建议。页面不得用 `sessionStorage` 或乐观步骤推断任务状态；抓取记录使用 Job snapshot。列表接口返回摘要投影，详情接口才返回正文、评分明细、去重证据和脱敏推送日志。

设置默认值、校验、敏感性和导出策略集中在 `src/lib/settings-catalog.ts`；AI Provider 定义在 `src/contracts/ai-provider.ts`；预设数据源定义在 `src/lib/preset-sources.ts`。Webhook 默认值为空数组，仓库不得保存真实 Webhook。当前去重规则唯一来源是 `src/contracts/dedup-settings.ts`：时间窗口 15 天、特定数字最少重叠数 2、正文 LCS 单段 40 字符、总长 160 字符、品牌门控开启、短文兜底 1000 字符。标题 Jaccard 仅作证据，不单独触发去重。

AI 重置与重复状态变更统一由 `src/lib/article-duplicate-state.ts` 生成更新数据；重新分析必须清空旧评分特征、模型审计、失败重试和重复证据，人工恢复重复文章时才保留 `dedupOverride`。删除文章会先解除其它文章的 `duplicateOfId` 逻辑引用，避免留下失效关联。

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
