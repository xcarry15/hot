# Hot2

Hot2 是面向餐饮与零售行业的新闻聚合、AI 分析、事件去重、异常纠错和飞书推送系统。

```text
数据源采集 → 正文处理与筛选 → AI 分析 → Event 聚类 → 公开展示 / 飞书推送
```

技术栈：Next.js 16、React 19、TypeScript、Prisma 6、SQLite、Vitest。

## 快速开始

环境要求：Node.js >= 20.9.0、npm >= 10。

```bash
npm ci
copy .env.example .env       # Windows
# cp .env.example .env       # Linux / macOS
npm run db:migrate:deploy
npm run db:generate
npm run db:seed
npm run db:optimize
npm run dev
```

访问地址：

- 公开站点：`http://localhost:3011`
- 管理后台：`http://localhost:3011/admin`
- 文章详情：`/news/[eventId]`

Windows 需要完全重建本地数据库时，可直接双击 `bat/本地一键初始化.bat`。入口使用纯英文 PowerShell 脚本执行，避免 CMD 中文编码问题；该操作会删除本地 SQLite 和历史数据，默认复用已有依赖。依赖异常或 `package-lock.json` 变更时，可执行 `bat/本地一键初始化.bat -RefreshDependencies` 强制重装依赖。

## 环境变量

```env
DATABASE_URL=file:../db/custom.db
API_TOKEN=
SETTINGS_ENCRYPTION_KEY=
NEXT_PUBLIC_SITE_URL=https://hot.kfxz.cn
```

- `DATABASE_URL`：SQLite 路径，默认指向 `db/custom.db`。
- `API_TOKEN`：生产环境必填，用于后台登录和受保护 API；未配置时生产环境拒绝访问。
- `SETTINGS_ENCRYPTION_KEY`：用于加密数据库中的 Webhook 等敏感配置，生产环境必填且部署间必须保持不变；本地未配置时仅使用稳定的开发回退值，绝不回退到可轮换的 `API_TOKEN`。
- `NEXT_PUBLIC_SITE_URL`：正式站点地址，用于 canonical、Open Graph 和 sitemap。

本地开发如需通过代理访问 OpenCode 等外部服务，可在启动 `npm run dev` 的终端设置 `HTTP_PROXY` / `HTTPS_PROXY`（可选 `NO_PROXY`）。开发服务器会自动使用这些变量；生产环境不会启用此逻辑。

公开首页、公开文章 API 和健康检查保持匿名访问；后台页面及其他 API 受 Token 会话保护。

## 核心架构

项目采用单进程模块化单体。Next.js 同时承载页面、API、调度器和任务执行器；生产环境只运行一个 PM2 实例，不需要 Redis、消息队列或独立 Worker。

### 数据模型

- `Source`：采集源及解析配置。
- `Article`：原始报道、正文、AI 结果和人工校准记录；归一化 URL 是采集去重的唯一标识。
- `ArticleSearch`：后台文章搜索的派生文本索引，只保存标题、摘要、品牌、事件键和正文的规范化拼接结果，避免列表搜索直接扫描完整 Article 行。
- `Event`：同一事件的聚合单元，也是公开展示和推送去重的唯一边界。
- `EventDirty`：每个 Event 至多一条事务后修复标记，防止公开快照异常造成重复恢复任务。
- `Job`：批量或单篇任务的状态、进度、租约、取消事实与有限恢复次数。
- `PushDelivery`：每个 Event 对每个推送目标的最新投递状态；`PushLog` 只保存历史审计。
- `DiscardedItem`：未进入 Article 的采集结果和重试记录。
- `Setting`、`Keyword`、`KeywordHit`、`PushTarget`：运行配置、筛选词、处理阶段命中明细和推送目标。

`Article` 与 `Event` 的职责必须保持分离：

- AI 必须先提取 `subjects / action / object`，应用再确定性生成 `eventKey`。
- 事件主体会对常见品牌别名做轻量归一；聚合快讯不强行归入其中一个子事件，而是自动按单篇建立已确认 Event。
- `brand` 只服务展示与搜索，不反向覆盖 `eventSubjects`；有清晰主事实的文章即使篇幅包含背景、行业分析或多个案例，仍提取该事实进入 Event。缺少完整身份但相关度和信息密度足够的文章自动建立独立 Event；只有广告、低相关或低信息密度的内容标记为“无价值”。这些业务结果都保留模型、Prompt 哈希和原始快照，且不计入技术失败。
- 每篇文章只请求一次 AI。解析器兼容常见字段命名；事件身份不完整时保留评分、摘要和审计信息，由聚类阶段自动按单篇建 Event，不追加身份修复调用、技术重试或人工事件校准。
- 数据维护中的低质量清理只处理内容不足；无价值和 AI 技术失败都不会被误删，技术失败继续由恢复队列处理。
- 广告判定只看文章核心目的；五险一金、劳动保障、员工福利等已验证的用工事实有代码兜底，不会仅因来源是企业或内容对品牌有利就判为软文；公益救灾、辟谣等内容仍按全文目的判断，避免品牌宣传被关键词强制洗成非广告。
- 计划/完成收购、启动/终止合作等方向相反的动作分别归一，不允许把传闻中的交易或渠道终止误写为“完成收购/启动合作”。
- 聚类默认用 7 天处理普通事件；同一事件的改写跟进报道允许在 14 天内归并，避免同一闭店、交易等长周期事件被拆分。
- `eventKey` 的主体、动作和具体事项只作为归并证据，不再要求 AI 生成的动作/事项逐字一致。结构化身份精确且不宽泛时，即使模型置信度不是高分也可直接归并；报道仅补充合作方等主体时，较短主体集合被完整包含、动作事项接近且标题或正文重合也可归并。时间接近时，标题共享至少两个非泛化锚点且事项有稳定交集，或同一主体、相近事项、相同可核查数值事实与标题或正文重合，即可自动归并；明确年份、季度、期次等限定冲突仍阻止归并。仅同品牌不再作为归并条件。
- 每篇文章只进行一次主 AI 分析，聚类不再二次请求 AI。明显转载可依标题与正文高度重合自动归并；相近但证据不足的候选保留规则审计后自动独立建 Event，人工只处理多主题或身份不完整稿。
- 跨媒体同标题转载即使因署名或图片说明导致全文哈希不同，只要正文 token 覆盖率和交并比都接近完全一致，也作为强重复证据归入同一 Event；不在采集阶段删除 Article，保留来源审计。
- 正文相似度在主体或标题锚点已有交集时参与聚类；AI 主体识别不稳定时，标题锚点也能开启正文证据，但仍不对所有候选做全文比较，避免同一站点的页脚、推荐栏和模板文案制造误合并。
- Article 保存内容处理、AI 与人工校准结果。
- Event 选择唯一代表 Article，并决定公开和推送状态。
- 自动代表文章在可用成员中保持最早发布时间优先；批处理也按发布时间从早到晚归并，历史补采不会因入库顺序改变代表关系。
- 非代表 Article 不公开、不推送。
- 运营统计中的“重复”只计同一 Event 的非代表 Article，代表 Article 仍是有效业务记录，不重复计数。
- `Event.publicStatus` 是公开状态的事实源。

### 处理流水线

| 阶段 | 代码 | 职责 |
| --- | --- | --- |
| collect | `src/lib/pipeline/collect.ts` | 读取数据源并写入采集结果 |
| process | `src/lib/pipeline/process.ts` | 获取正文、清洗内容、关键词筛选 |
| ai | `src/lib/pipeline/analyze.ts` | 生成摘要、评分和结构化事件身份 |
| cluster | `src/lib/pipeline/cluster.ts` | 把 Article 归入 Event，或按单篇自动建立独立 Event |
| push | `src/lib/pipeline/push-bridge.ts` | 按 Event 和目标执行推送 |

`src/lib/execution.ts` 是 Job 的统一调度入口；采集、AI 批处理、单篇工作流和阶段执行器分别位于同目录的 `execution-*.ts`，固定阶段通过 `src/lib/pipeline/stage-runner.ts` 共享执行前取消检查、阶段顺序和失败补偿语义。批量阶段会分块处理全部当前积压；分块大小不是任务完成边界。任务中心会在当前运行阶段显示该阶段的实时完成数和总数；文章步骤会显示 Event 代表文章的公开状态，正常筛选也支持按已公开、未达推送门槛和不参与推送查看；异常筛选聚焦需人工处理、无价值、自动恢复、待复核、流程失败、软文、重复和低分析置信，文章行同步展示原因。正文抓取、AI 和聚类失败原因会持久化并显示在对应文章；单篇正文重跑失败会中断后续 AI/聚类并将 Job 标记失败；最近任务失败时会在任务区显示失败原因。数据源成功请求但解析为 0 篇会作为警告而非失败显示。调度器位于 `src/lib/scheduler.ts`，自动采集默认关闭，配置从数据库读取；每分钟还会独立检查到期的技术失败，只运行不重新采集数据源的恢复全流程。聚类批处理开始前会校正失效的 Event 代表文章指针，保证 `representativeArticleId` 的唯一所有权；候选 Event 和每个候选的成员比较都有显式上限，避免数据增长时单篇任务无限放大。

Event 归属和代表文章重算在同一事务提交；事务后的公开快照异常以每个 Event 一条最新脏标记进入受控修复队列，不会无限累积重复恢复记录。

采集阶段会先按归一化 URL 批量检查已入库和已丢弃条目；同 URL 不会重新抓取正文、执行 AI 或聚类，仅在标题、发布日期变化时更新列表元数据。数据源创建和预设添加会按规范化后的来源 URL 判断重复，但持久化仍保留原始列表 URL，避免目录页尾部斜杠影响相对链接解析。全源采集保持最多 4 个来源并发，但同一 hostname 在同一批次只运行一个来源，减少同站多分类页同时请求导致的反爬和空结果。若同一列表 URL 的旧来源已删除后被重新添加，成功解析列表后会接管旧来源中未完成的文章并恢复抓取，避免 URL 唯一约束造成文章不可见。采集结果中的“发现”是列表解析数量，“新增”仅计实际写入的 Article，去重和接管不会被误报为新增。
HTML 来源在同域重定向或短验证页中下发的验证 Cookie 仅在当前请求链临时回传，不执行页面脚本、不持久化，也不会转发至其他域名。

### 发布与推送边界

基础门禁集中在 `src/lib/event-release-policy.ts`：

- Event 必须为 active 且聚类审核已确认。
- Article 必须是当前代表、完成 AI 和聚类，且来源未删除。
- 来源公开开关、评分、相关度和软文规则属于公开策略。
- 推送开关、目标状态和投递模式属于推送策略。
- `needs_review` 不得成为代表、公开或推送。

公开数据由 `src/lib/public-publication-service.ts` 维护快照，读取逻辑位于 `src/lib/public-article-service.ts`。推送实现位于 `src/lib/push/`，支持：

- `normal`：正常流水线推送
- `retry_failed`：仅重试失败目标
- `manual_force`：人工强制推送，但不绕过 Event 完整性门禁
- `repush_all`：对当前 Event 的启用目标完整重推

自动批量推送按固定窗口持续消费积压；任一启用目标出现结果未知时，Event 立即退出自动队列，只能由管理员使用 `manual_force` 明确确认。设置页中的飞书 Webhook URL 持久化时使用 AES-256-GCM 加密，仅保留末 6 位作为目标识别标记；设置 API 会限制为最多 10 个合法 HTTP(S) 目标及其长度，编辑态空草稿不会入库。设置页回显和推送运行时由服务端解密，推送目标名称不保存完整 URL。

影响评分或公开规则的设置只在短事务内保存并写入重建标记；重算由专用 Job 分批执行。即时入队受当前任务占用或临时故障影响时，设置仍保存成功，调度器会在下一次 tick 自动续跑。

设置页「数据」中的配置导入/导出用于完整设置迁移，包含所有可编辑设置、AI API 密钥和 Webhook；导出文件包含可恢复的明文敏感配置，必须妥善保管。

## 代码结构

```text
src/app/                 页面、Route Handler、robots 和 sitemap
src/components/          公开端与管理后台 UI
src/components/article-workspace/ 文章抽屉事件成员/候选共享紧凑卡片
src/components/intelligence-inbox/ 文章抽屉的容器状态、展示模型与内容/事件分区组件
src/features/            浏览器端 API 客户端
src/contracts/           前后端共享 DTO、关键词和流程状态契约
src/lib/                 服务、流水线、调度、公开和推送逻辑
src/lib/event/            Event 查询、代表选择和聚类证据
src/lib/pipeline/         阶段实现与共享 stage runner
prisma/                  Schema、seed 和当前单一 baseline migration
tests/                   Vitest 测试
scripts/                 生产初始化、部署和数据库维护脚本
bat/                     Windows 初始化、打包和运维文档
.github/workflows/        CI 与生产部署流程
```

职责约束：

- Route Handler 只处理鉴权、参数和响应转换，业务规则放在 `src/lib/`。
- API 不直接向浏览器返回 Prisma Model，应通过 `src/contracts/` 中的 DTO。
- 设置定义集中在 `src/lib/settings-catalog.ts`。
- `src/lib/event-service.ts` 保留稳定 facade；只读查询和纯聚类证据分别位于 `src/lib/event/`，事务重算与人工变更仍保持在 Event 领域服务边界内。
- 人工字段修正反馈集中在 `src/lib/feedback-service.ts`。
- 公开规则和推送规则不得复制到 React 组件。

## 常用命令

```bash
npm run dev                 # 开发服务：http://localhost:3011
npm run build               # 生产构建
npm run start               # 启动生产服务
npm run lint                # ESLint
npm run typecheck           # TypeScript 类型检查
npm test                    # 默认测试
npm run test:critical       # 核心业务测试
npm run test:migrations     # 空 SQLite migration 冒烟测试
npm run test:all            # 默认测试 + migration 测试
npm run verify              # lint + typecheck + 全测试 + build
```

数据库命令：

```bash
npm run db:migrate          # 本地创建或应用开发 migration
npm run db:migrate:deploy   # 应用已有 migration
npm run db:migrate:status   # 检查 migration 状态
npm run db:generate         # 生成 Prisma Client
npm run db:seed             # 写入初始配置和预设数据
npm run db:optimize         # 启用/检查 WAL 并执行 PRAGMA optimize
npm run db:cleanup-logs     # 清理过期运行日志
```

日常生产部署禁止使用 `db:push` 或 `db:reset`。当前仓库只有 `prisma/migrations/20260731120000_current_schema_baseline` 一个 migration；首次切换到该基线必须备份后执行 `CONFIRM_RESET=YES bash scripts/init-production.sh`，之后日常更新才使用 `npm run db:migrate:deploy`。本项目不为历史业务数据维护兼容层；结构或规则变化按重新采集新数据处理。

## 管理后台

后台导航收敛为：

- `工作台`：任务监控、技术恢复、Article 校准、Event 修正、公开决策和人工推送；“全部文章”搜索读取 `ArticleSearch` 派生索引，覆盖标题、已抓取正文、摘要、品牌和事件键，但不在列表查询中直接扫描完整 Article 正文。公开文章被删除、撤回或失去公开资格后，旧的推送链接统一跳转首页。
- `设置`：数据源、关键词、AI、评分、推送目标、自动抓取调度和数据维护；自动抓取开关、抓取间隔与 AI 并发数均可维护。提示词页支持保存 System 与 9 个评判块的命名版本，可先与当前页面按字段、行级差异对比，再载入后统一保存；评分权重和其他运行设置不随版本切换。工作台右上角“自动抓取”是同一开关的快捷入口，保存后两处即时同步。

技术失败由任务区域处理；内容与 Event 异常纠错由文章详情抽屉处理。两者共享同一工作台，但服务层职责不合并。工作台的“正常 / 异常 / 技术已忽略”只表达流水线状态，不再维护“重要 / 一般 / 无关”人工归类；公开控制直接使用 Article 的自动、公开、隐藏三态，并继续服从 Event 代表文章和来源公开开关。关键词过滤、重复或内容过短的条目没有 Article 记录，属于“未入库”诊断。业务层只保留两种当前数值置信度：`aiConfidence` 是 AI 对整篇结构化分析的证据充分度，`eventKeyConfidence` 是事件身份提取的可区分把握；`EventClusterAudit.confidence` 仅保留历史 AI 归类记录。精确匹配、规则判断和人工确认是决策方式，不制造百分比。事件身份置信度缺失按 0，宽泛身份最高 60，人工修正也使用同一封顶规则；成对事件身份判断取两篇文章置信度的较小值，任一缺失均按 0。每篇文章只调用一次 AI，聚类只比较结构化身份、时间、标题和正文证据：通过完整性校验的相同身份直接归并，相近但不足以合并的文章自动独立建 Event，多主题或身份不完整稿也按单篇自动收敛，人工只处理确有成员归属歧义的 Event。AI 温度允许设置为 0，表示关闭随机性。技术失败使用有限次自动重试；到期任务每分钟由恢复调度触发，自动采集开关关闭也不影响已有文章的技术恢复，耗尽次数后转为人工处理；管理员点击“运行全流程”时会提前触发仍在自动恢复等待窗口内的正文、AI 和聚类重试。

文章详情抽屉按运营决策顺序组织为“文章状态与主要操作 → 内容理解 → 审核与发布 → 事件校准 → 正文核验与推送记录”。顶部只保留查看原文和编辑文章两个主要操作；来源、访问和人工覆盖信息默认常驻显示，品牌后直接展示公开浏览与原文点击，原始文章链接保持普通文字样式但可直接访问。顶部当前结论直接说明“可公开 / 待复核 / 需要处理”及其原因。桌面端的核心要点与 AI 洞察并列且使用相同最大高度，AI 洞察直接展示完整结论；移动端保持“核心要点 → AI 洞察 → 审核与发布”的自然顺序。编辑态的可输入字段统一使用黄色底色，并提示事件身份修改会重新计算归属、公开资格和推送结果。综合分复用工作台文章列表的分数色阶，内容分、事件分、相关度、AI 分析置信度、广告概率、事件身份置信度和原始评分与公开策略、隐藏、推送及“全量重跑”集中在审核区并全部直接显示；审核区同时区分文章覆盖、事件公开结果、推送目标结果和公开门禁原因，高风险写操作继续二次确认；推送记录始终显示，无记录时展示明确空状态。事件校准不使用横向宽表或切换页签，当前事件键与本篇归类方式合并到当前成员标题行，当前文章固定排在成员列表首位；事件区显示事件活跃状态、聚类审核状态、时间范围和代表文章产生方式，并将事件身份拆分为主体、行为、具体事项。尚未归入 Event 的文章也会显示事件区，并提供“自动建立独立事件”操作；当前成员、系统关联候选和同品牌候选按从上到下的紧凑卡片完整展示。候选显示品牌交集、事件身份关系和时间间隔，并可打开文章事件对比视图。操作记录以“结果、执行方、判断来源、时间、判断依据”结构化展示；仅历史 AI 判断额外显示其归类置信度。更改所属事件使用常驻紧凑搜索和结果行。业务上的“无价值”显示为分析结果而非技术错误；有价值但缺少完整事件身份的文章自动建立独立 Event。移动端采用纵向信息流、可换行操作和无横向溢出的卡片布局。

AI 遇到限流、超时或临时上游错误时，会暂停未开始的分析并标记为“AI 等待”，冷却后由恢复调度自动继续；这些文章不再被批量标记为失败，也不会消耗各自的失败次数。鉴权、余额或模型配置错误只记录实际触发文章，未开始文章保持可恢复状态。

数据维护中的“重置 AI”会同时解除目标 Article 的旧 Event 归属并重置聚类状态；重新分析后按新结果重新生成 Event，不保留旧聚类兼容层。

管理员把 Article 移入已有 Event 时，只调整 Event 归属和聚类确认状态；Article 仍保留自身 AI/人工校准得到的事件身份，避免把 Event 代表身份反写为 Article 的分析事实。

单篇恢复统一使用 `POST /api/articles/[id]/workflow`：

- `retry`：只重试当前可恢复的失败阶段。
- `regenerate`：从指定阶段重置并重新计算。

## 性能边界

当前规模采用轻量优化：

- SQLite WAL、必要索引和短事务。
- 公开列表使用稳定游标分页和有界短缓存；列表只返回按日期分组的截断摘要，原文地址与完整 AI 洞察按详情读取。
- 后台详情按需加载，轮询在页面隐藏时暂停。
- Job、公开统计和技术待办使用短缓存合并重复读取。
- 批处理按固定 chunk 消费全部积压，避免一次加载无限数据。
- Event 详情查询和聚类证据分别位于 `src/lib/event/event-query-service.ts`、`src/lib/event/event-cluster-evidence.ts`；文章抽屉的成员、系统关联候选和同品牌候选共用无横向滚动的 `EventArticleRowModel` 紧凑卡片。
- 关键词命中数采用 15 秒短缓存，只统计最近 90 天启用来源的新处理文章；白名单词读取 process 阶段写入的 `KeywordHit` 明细，不再打开设置页时扫描正文。黑名单词则统计同一窗口内带有该词审计记录的拦截文章，避免已拦截内容始终显示为 0。

在有明确性能数据前，不引入 Redis、消息队列、微服务或多实例 PM2。

## 测试与自动部署

GitHub Actions 配置：

- `.github/workflows/ci.yml`：`master` push、Pull Request 或手动触发；执行 lint、类型检查、单元测试、migration smoke 和生产构建。
- `.github/workflows/deploy.yml`：`master` 的 CI 成功后自动部署生产；也支持手动重新部署。

部署流程会在停机前确认数据库已记录当前 baseline；随后停止 PM2、备份 SQLite、同步并删除旧代码、安装依赖、应用 migration、构建、以单实例启动 PM2，并检查 `/api/health`。旧 migration 历史会被明确拒绝，不执行隐式兼容升级；服务器上的 `.env` 和 `db/` 不会被发布包覆盖，且部署前会校验 `API_TOKEN`、`SETTINGS_ENCRYPTION_KEY` 和 `NEXT_PUBLIC_SITE_URL`。

服务器全新初始化使用：

```bash
cd /www/wwwroot/hot.kfxz.cn
bash scripts/init-production.sh
```

交互终端输入 `RESET` 确认；自动化环境需显式使用 `CONFIRM_RESET=YES bash scripts/init-production.sh`。

完整步骤见 `bat/部署和更新方法.txt`，Nginx 模板见 `bat/本项目的nginx.txt`。

## 关键词工作簿

关键词页使用 XLSX 导入/导出，工作簿包含正式关键词、已采用候选词、永久忽略候选词和待确认候选词四个 Sheet；导入会恢复候选词状态，并对已采用词继续恢复本机未入库文章。正式关键词中的「黑名单」分组拥有最高优先级，命中后会在入库前拦截文章。

## 安全规则

- 不提交 `.env`、API Token、Webhook、SSH 私钥、SQLite 数据或部署压缩包。
- 生产环境必须设置强随机 `API_TOKEN` 和稳定的 `SETTINGS_ENCRYPTION_KEY`。
- 数据源、正文抓取和 Webhook 只允许访问公网地址；本地/内网地址和超大响应会被拦截。
- PM2 只能运行一个 `h2-hot2` 实例，禁止 `-i max` 和 cluster 模式。
- 普通发布不清理服务器全局 Nginx 缓存，也不 reload Nginx。
- migration 前先备份数据库；出现 drift 时停止操作，不要 reset 用户数据库。
