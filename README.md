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
npm run db:optimize
npm run dev
```

开发地址：`http://localhost:3011`。根路径 `/` 是公开新闻卡片页，文章详情使用 `/news/[id]`；后台位于 `/admin`，左侧导航依次为“任务中心”“内容管理”“设置”。生产环境必须在 `.env` 设置 `API_TOKEN`，首次访问后台时输入该 token 建立临时 HttpOnly 会话；Cookie 保存由 Token 派生的会话值，不直接保存可调用 API 的原始 Token，旧版原始 Token Cookie 不再兼容。公开端保持匿名访问。生产部署还应将 `NEXT_PUBLIC_SITE_URL` 设置为正式访问地址，用于 canonical、Open Graph 和 sitemap。公开导航中的“工具”“数据”目前是占位入口，暂未提供实际页面。

交互性能采用轻量策略：后台三个顶层页面与设置子页面按访问动态加载，导航及设置标签悬停、聚焦或触摸时预加载目标代码块，深链会直接加载目标页面，后台内部跨页面深链不触发整页刷新；导航待办计数按首次进入、低频切换和窗口重新聚焦刷新，不再每次切换重复请求。分享海报组件和二维码依赖只在用户点击分享后挂载。公开 Event 持久化 `publicDateKey/publicSortAt`，公开列表先读取有限日期键，再只查询这些日期的文章，每个日期保留 250 篇硬上限，不再以全库正文扫描支撑分页；公开总数与刷新探测共享 60 秒短缓存，翻页不重复执行相同全量计数。文章详情的 metadata 与页面渲染复用同一次详情读取，服务端详情结果使用最多 100 个 key、30 秒的有界短缓存，上一篇/下一篇只读取当前日期组和相邻日期边界，其他来源读取由 `eventId/publishedAt/createdAt` 联合索引支撑；公开列表短缓存限制为最多 50 个 key。内容管理与任务中心会在用户停留 120ms 后预取详情，快速划过会取消，并在 15 秒内合并/复用请求结果，减少连续切换文章时的等待和无效网络请求。公开详情的浏览量只在页面真实挂载并停留片刻后记录，路由预取、metadata 读取和公开详情 API 查询不会误计为浏览。内容管理列表只查询当前分页和总数，不再为未使用的筛选项每次扫描全表。任务中心按项目日处理量读取最近 250 篇 Article 和 250 条未入库记录，并额外补齐不在该窗口内的全部技术待办 Article；任务运行时每 3 秒只读取轻量 Job 进度，阶段变化或任务结束才刷新完整文章记录，空闲时每 15 秒刷新，页面不可见时暂停周期请求。技术工作队列使用 5 秒短缓存合并导航计数和任务中心的重复扫描，Job 完成后立即失效，导航人工待办数由数据库直接唯一计数。数据看板统计使用 15 秒短缓存合并重复请求，隐藏时暂停 30 秒自动刷新，Job 历史查询限制为最近 500 条；Job 完成后统计缓存立即失效。采集阶段按数据源批量预取本轮 URL 对应的 Article 和 DiscardedItem，关键词候选一次批量预取并在短事务中写入，浏览量和原文点击统一聚合到单个短事务落库。

后台顶层页在首次访问时动态挂载，此后切换会保留页面状态、滚动位置和已加载数据；隐藏的任务中心和 Dashboard 暂停轮询，避免用保持状态换取后台空转。

内容管理是全量文章人工校准工作台：左侧直接显示流程、聚类状态、来源数和代表文章，并提供待归类、聚类待复核、低置信度、多来源、代表文章和人工修正视图；右侧集中处理评分、内容、公开策略、聚类依据、成员移动、独立成新事件、事件合并和代表文章。`articleId + panel=cluster/content` 可精确定位文章和校准区；目标文章已删除时会自动清理失效定位并返回当前列表。主动重新生成统一提交持久化单篇 Job。Article 保留 AI 与人工校准结果，Event 是公开和推送的唯一门禁。

任务中心按真实流水线展示 `采集 → 处理 → 聚类 → AI → 推送`，负责 Job 监控和技术恢复。状态区域采用单选筛选，依次提供全部、需处理、自动恢复、已忽略、待处理、待聚类、待 AI、待推和已推送；数据源、今天和含未入库保持独立筛选。普通流水线列表仍只读取最近 250 篇 Article，但会额外合并全部“需人工处理”和“自动恢复中”文章，保证技术待办不因时间窗口丢失，且按 Article.id 去重。当前任务区展示任务范围、目标文章或数据源、阶段队列、当前阶段、完成数、百分比和错误数；项目使用全局单 Job 模型，不伪造多任务等待队列。正文处理、聚类、AI 与推送采用有限自动重试：仍在退避窗口内显示“自动恢复中”，此时管理员也可直接“强制忽略”，立即停止后续自动重试；达到 5 次上限后转为“需人工处理”，不再进入自动任务。忽略后不计入技术待办，并可通过“已忽略”筛选随时恢复。每篇文章只暴露当前失败步骤的原位恢复操作；单篇 Job 会在快照中携带目标 Article 和当前阶段，使对应步骤在任务整个运行期间持续显示加载状态。点击已入库文章标题会直接深链到内容管理的对应文章与内容面板，不再打开重复的流程诊断弹层；悬停或聚焦标题时同时预加载内容管理代码块和文章详情，以降低跳转等待。AI 分析完成的文章会在标题前显示最终有效评分；“去聚类复核”仍深链到内容管理的聚类面板。推送失败只投影到 Event 当前代表 Article，非代表成员显示为不适用。

任务中心筛选采用两级互斥分类：第一层为全部、正常、异常和已忽略；正常细分为全部正常、处理中、待 AI、待推送和已推送，异常细分为全部异常、需处理、待复核、业务过滤和流程失败。每篇文章只归入一个细分类：人工待办优先，其次是聚类复核、技术失败或自动恢复、软文或重复等业务过滤，最后才按正常流程阶段归类。普通待聚类属于“正常 → 处理中”，不再显示异常标签；技术聚类失败归入“异常 → 流程失败”。自动恢复期间，文章标题后显示红色“异常”标签，恢复成功并清除技术状态后自动消失。业务识别标签使用实色背景区分，技术失败、自动恢复与人工处理使用醒目状态色；标签仅用于快速识别，不改变流程状态或技术恢复规则。

文章行的条件性操作与对应状态标签统一放在标题区域，全部按“状态标签 → 操作按钮”排列；强制忽略、去聚类复核、忽略和恢复均使用细黑边框并位于对应状态最后，避免右侧固定流程列和时间列随操作按钮出现而移动。

任务中心只展示已启用且未删除的数据源分组；禁用源的历史文章、未入库记录和上次 Job 源结果均不在该页展示。页面不再显示同步时间或空闲时的上次任务进度条；数据源展开后直接显示文章，仅未入库原因分组保留折叠。数据源标题在名称后紧凑显示完整快照的本次发现、文章、推送、异常、需人工处理、自动恢复和未入库数量，不随列表筛选变化；“今日发布”按文章自身的 publishedAt 过滤。

任务中心的分阶段运行按钮与顶部控制合并为同一紧凑工具行，统一使用小尺寸方角按钮，不提供低频的数据源下拉筛选，减少顶部纵向与横向占用。

任务中心的异常二级筛选不再合并显示“业务过滤”，改为独立的“软文”和“重复”按钮，分别按 `isAd` 与非代表 Event 成员统计。同一篇文章可同时命中两个筛选，不改变其流程状态。

## 项目结构

```text
src/app/              公开页面、后台页面和 API Route Handler
src/app/admin/        Token 保护的管理后台
src/app/news/         可分享、可收录的公开文章详情页
src/app/robots.ts     robots 规则；仅公开首页和文章详情参与收录
src/app/sitemap.ts    公开首页和文章详情 sitemap
src/components/       内容管理、设置、数据源、任务中心和公开端 UI 组件
src/features/         前端 API 客户端
src/contracts/        API、AI、文章、推送等共享契约
src/lib/              execution、pipeline、AI、推送、去重、设置等核心模块
prisma/               schema、seed、migration 历史
tests/                Vitest 测试
scripts/              migration baseline 与维护脚本
bat/                  Windows 启动、打包、部署和 Nginx 文档
db/                   本地 SQLite 数据（不进入部署包）
```

公开端以 active Event 为内容单位，每个 Event 只展示一张卡片，正文和评分取代表 Article 的最终人工校准结果，详情页同时列出其他报道来源。`Event.publicStatus` 是唯一公开事实源；Article 仅保存人工公开策略和当前代表文章的公开结果投影，非代表成员固定为未公开。代表文章切换时会同步清理旧代表投影；`/news/[id]` 的 id 为 Event.id。浏览和原文点击仍累计到当前代表 Article，且不会污染公开内容更新时间；两类计数均为单实例内存短聚合后落库的近似统计，进程异常终止时允许丢失极少量未刷新计数。

## 当前架构与数据事实

- Next.js 16 App Router + React 19 + TypeScript；Prisma 6 + SQLite；单进程模块化单体，生产只运行一个 PM2 实例。
- `src/lib/execution.ts` 是唯一批量 Job 编排入口，内存互斥保证同时只有一个批量任务。process、cluster、AI 阶段会按固定大小分批消费本次符合条件的全部积压，不会因单批上限而把未处理完的任务标记为成功。Job 表的阶段、进度、错误数和 heartbeat 是任务状态事实源；停止通过 `AbortSignal` 协作式取消。
- 调度器每分钟 tick；自动抓取默认关闭。普通批量任务使用 `/api/crawl` 的 `all` 阶段，分阶段入口 `collect / process / cluster / ai / push` 仅供管理员运维。

| 阶段 | 入口代码 | 作用 |
|---|---|---|
| collect | `src/lib/pipeline/collect.ts` | 采集数据源并写入/更新文章 |
| process | `src/lib/pipeline/process.ts` | 抓取详情、提取正文、关键词过滤；不同 URL 的重复文章保留并标记 |
| cluster | `src/lib/pipeline/cluster.ts` | 将已处理 Article 归入 Event，记录失败重试与待复核状态 |
| ai | `src/lib/pipeline/analyze.ts` | 写入摘要、标签、评分和审计字段 |
| push | `src/lib/pipeline/push-bridge.ts` | 按统一条件投递未推送文章 |

关键 API 约束：`POST /api/crawl` 是批量任务主入口；`POST /api/articles/[id]/workflow` 是单篇处理、聚类、AI 和普通推送恢复/重跑的唯一入口，其中 `retry` 只允许当前可恢复失败步骤，`regenerate` 会按起点重置并重算，且不能用于完整重推；`POST /api/articles/[id]/technical-status` 仅负责忽略或恢复技术待办，不删除 Article。推送服务使用 `normal`、`retry_failed`、`repush_all` 三种明确模式：流水线普通推送、最新失败目标恢复、Event 级完整重推。`GET /api/crawl-log/status` 与 `GET /api/admin/work-queue-summary` 共同复用唯一技术待办事实源；推送失败只映射到代表 Article，并按当前启用目标的最新 PushLog 判断。旧 `/api/articles/refetch`、`/api/articles/reprocess` 和 Article 级 `/api/push` 已删除。Route Handler 只做适配，事务和业务规则由 Service 负责。

`InboxSnapshot` 保存近 90 天的待归类积压快照，概览以此展示积压趋势；快照是派生指标，不改变文章流水线事实。

关键词未命中候选只从标题本地提取，不调用 AI：数字及数字混合片段不进入候选，中文片段按较长词优先并移除被长词覆盖的短片段，每个标题最多记录 12 个。候选列表优先展示跨来源出现的词，再按出现次数和最近更新时间排序；人工采用后统一写入“提取”分类，并恢复最近最多 50 篇对应的未命中文章重新处理。

`Job`、`FetchLog`、`PushLog`、`DiscardedItem` 和 `EventClusterAudit` 分别记录任务、采集、事件目标级推送、未入库条目和聚类/人工纠错事实。`Article` 记录全文、AI 与人工校准、归类和事件归属；`Event` 记录代表文章、来源数量、公开状态和唯一推送状态。PushLog 关联 Event，并保存投递时的代表 Article；历史展示与来源统计使用该发送时快照，不跟随当前代表文章变化。未配置可用 Webhook 时，批量推送直接跳过，不为每个 Event 重复写失败日志。

设置默认值、校验、敏感性和导出策略集中在 `src/lib/settings-catalog.ts`；AI Provider 定义在 `src/contracts/ai-provider.ts`。事件聚类规则集中在 `src/contracts/event-clustering.ts`：只比较最近 7 天 active Event，内容指纹或标准化标题完全一致时直接归入，规则证据不足时调用 AI，仍不确定则保守新建并标记复核。`needs_review` 允许继续 AI，但禁止公开和推送，必须人工确认独立或移动到正确 Event。第一版不引入 Embedding。

AI 重置由 `src/lib/article-ai-reset.ts` 中的重置 helper 统一生成，重新分析继续保留人工覆盖。旧 Article duplicate 状态和“取消重复并分析”入口已经删除；内容指纹只作为 Event 聚类证据。

公开端保持自动发布：只有代表 Article 已完成聚类（`clusterStatus=clustered`）、AI 完成、来源允许公开并满足评分/软文规则时才进入公开快照；`pending`、`failed`、`needs_review` 均不得成为代表文章、公开或推送。自动代表文章先要求聚类和 AI 完成、来源未删除，再比较人工重要、评分、相关度和正文质量；人工指定代表文章同样必须满足该基础资格。来源是否允许公开继续由公开门禁独立判断，避免一个关闭公开的来源让 Event 错选低质量代表文章。后台可人工修正摘要、品牌、分类、标签、关键点和评分，并对单篇设置公开、隐藏或恢复自动规则。收件箱使用人工待处理视图，不把抓取、聚类、AI 或推送技术失败混入人工队列。

## 数据库与生产部署

项目按 Prisma migration 发布，不使用 `prisma db push` 作为日常部署方式。当前 migration 按序位于 `prisma/migrations/`，生产由 `npm run db:migrate:deploy` 自动应用。历史 `db push` 库首次切换前必须停服务并备份：

```bash
npm run db:migrate:baseline
npm run db:migrate:deploy
npm run db:migrate:status
```

出现 drift 必须停止并人工检查，不要 reset 或覆盖数据库。SQLite 统一使用 WAL、`synchronous=NORMAL`、`busy_timeout=5000` 和外键检查；服务启动时会幂等初始化并输出状态，部署迁移后也应执行 `npm run db:optimize`。生产更新顺序：停止 PM2 → 备份 SQLite（同时考虑 `-wal`/`-shm`）→ `npm run db:migrate:deploy` → `npm run db:generate` → `npm run db:optimize` → `npm run build` → 重启 PM2。

```bash
npm install
npm run db:migrate:deploy
npm run db:generate
npm run db:optimize
npm run build
pm2 delete h2-hot2 && pm2 start npm --name h2-hot2 -- start
```

日常运维：`npm run db:migrate:status`、`npm run db:optimize`、`npm run db:cleanup-logs`、`npm run db:rebuild-public`、`pm2 status`、`pm2 logs h2-hot2`。日志保留周期由 `src/lib/log-retention.ts` 统一负责：FetchLog 30 天，PushLog 90 天但保留未完成全部投递的记录，已完成/失败 Job 30 天；不会删除 Article、Source、DiscardedItem 或 pending/running Job。`db:reset`、`db:push` 仅限明确的本地重建或应急场景。

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
