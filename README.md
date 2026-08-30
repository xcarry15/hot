# 开发选址助手

开发选址助手面向餐饮与零售行业，提供经过筛选的行业资讯，以及选址、地图和数据分析工具。

后台负责资讯采集、正文处理、AI 分析、事件聚类、公开展示和飞书推送：

```text
采集 → 正文处理与筛选 → AI 分析 → Event 聚类 → 公开展示 / 推送
```

技术栈：Next.js 16、React 19、TypeScript、Prisma 6、SQLite、Vitest。

> 对外产品名统一为“开发选址助手”。`hot2`、`hot`、`h2-hot2` 仅保留为 npm 包、PM2 应用、部署文件等内部技术标识。

## 产品入口

- `/`：精选行业资讯列表。
- `/news/[id]`：公开资讯详情，`id` 为 Event ID。
- `/tools`：选址、地理位置、数据分析和文件工具目录。
- `/about`：产品说明与联系入口。
- `/admin`：Token 会话保护的管理后台。
- `/api/health`：匿名就绪检查；同时验证应用进程与 SQLite 可访问性，数据库异常时返回 503；GitHub Actions 发布包还返回当前 Git revision 供部署验收。

公开端统一复用 `PublicPageShell`、公共头部与页脚；产品名称和文案常量集中在 `src/lib/public-brand.ts`。

## 核心架构

### Article 与 Event

- `Article` 保存来源文章、正文、AI 结果和人工校准记录。
- `Event` 是聚类、公开展示和推送去重的唯一业务边界。
- 每个有效 Event 只有一个代表 Article；非代表文章不公开、不推送。
- `Event.publicStatus` 是公开状态事实源，Article 上的公开字段只是代表文章投影。
- AI 先提取 `subjects / action / object`，应用再确定性生成 `eventKey`；聚类阶段不重复调用 AI。
- 代表文章必须已完成 AI 与聚类，且来源未删除；来源公开开关仍是独立门禁。
- `needs_review` 只在 AI 分析后产生，在确认前不能成为代表文章、公开或推送。

公开读取和发布规则集中在 `src/lib/public-article-service.ts`、`src/lib/public-publication-service.ts` 和 `src/lib/event-release-policy.ts`。Route Handler 只处理鉴权、参数与响应转换。

### 流水线与恢复

| 阶段 | 主要代码 | 作用 |
| --- | --- | --- |
| collect | `src/lib/pipeline/collect.ts` | 读取数据源并写入采集结果 |
| process | `src/lib/pipeline/process.ts` | 获取、清洗正文并执行关键词筛选 |
| ai | `src/lib/pipeline/analyze.ts` | 生成摘要、评分和事件身份 |
| cluster | `src/lib/pipeline/cluster.ts` | 归入 Event 或进入待复核 |
| push | `src/lib/pipeline/push-bridge.ts` | 按 Event 和目标执行推送 |

- 单篇恢复统一使用 `POST /api/articles/[id]/workflow`：`retry` 重试当前可恢复失败，`regenerate` 从指定阶段重新计算。
- 批处理会持续消费当前可处理积压；查询 chunk 只是单批大小，不是任务完成边界。
- AI Provider 冷却状态只持久化在 Article 的 `nextAiRetryAt`；人工运行全流程会立即归一化等待、失败及旧 Event/聚类残留，重新获取正文后再探测 AI，不使用进程内熔断状态阻塞恢复。
- 长正文 AI 请求使用足够的 Provider 超时；单篇超时或网络失败只进入该文章的有限重试，不暂停同批后续文章。鉴权、余额、限流和服务端 5xx 仍按 Provider 全局故障处理。
- 技术失败经过有限自动重试后进入人工处理；不会通过删除 Article 来隐藏失败。
- 工作台文章标签会显示软文、重复、低分析置信和未达门槛；其中“未达门槛”由当前推送步骤的评分/相关性过滤状态派生，不代表抓取或 AI 流程失败。
- HTML 来源失败会保留实际 HTTP 状态、重定向后的最终 URL，以及实际使用的直连/代理路径和 ZAI page_reader 原因；可选的详情发布时间补全只访问本轮可能新建的 URL，不对历史文章重复抓取。
- 正文详情请求由文章层统一负责退避；共享 HTTP 层不再与外层重复重试，单篇抓取期间 ZAI page_reader 最多调用一次，避免失败时放大请求量。
- 设置页的“测试连接”使用独立的 15 秒单次超时且不自动重试，避免交互按钮复用后台长任务策略而长时间阻塞；正式文章分析仍使用 Provider 对应的长超时和重试规则。
- 调度器按数据库 Job 状态运行，并遵守 `Asia/Shanghai` 的静默时段；手动操作不受静默时段限制。
- `PushDelivery` 保存当前目标投递状态，`PushLog` 只作为历史审计。

### 工具目录

- 运行时数据来自 `ToolDirectoryItem` 与 `ToolDirectoryCategory`，公开端不以静态目录作降级数据源。
- 数据库为空时，`prisma/seed.ts` 才会写入 `src/components/public-tools/tool-catalog.ts` 中的初始化快照和默认分类；之后由后台维护。
- 分类、展示标签、工具状态和图标契约集中在 `src/contracts/tool-directory.ts`；后台编辑时状态选项与展示标签合并为同一组标签，前四项互斥。
- 仅 `active` 且具有公网 HTTPS 地址的条目可点击；其他未归档条目继续展示但不可打开，公开数据中也不会下发其 URL。
- `设置 → 工具中心` 提供工具新增、编辑、排序、归档和恢复，以及分类改名和排序；保存后会失效公开目录缓存。

### 备份、导出与维护

- `设置 → 备份` 是唯一的数据迁移入口：完整加密 JSON 一次包含可编辑设置、提示词版本、数据源、关键词与候选词、工具目录；旧的设置、提示词和工具独立备份接口不再保留。
- 完整恢复先在浏览器使用保护密码解密并校验全部模块，再在同一数据库事务中覆盖配置；数据源运行状态重新初始化，关键词过滤临时结论失效，并统一安排评分或公开状态重建。备份不包含文章正文、运行日志和任务历史。
- 关键词 XLSX 批量编辑与文章 Excel 归档也集中在 `设置 → 备份`；关键词 XLSX 与完整 JSON 共用正式关键词、候选词、出现次数和示例标题字段，候选词状态由工作表名称表达，不再重复保存“状态”列。前者是专项迁移格式，后者只读、不可用于恢复完整配置。
- `设置 → 维护` 只负责日志清理、文章清理和数据库压缩，不再混放导入导出操作。
- Excel 导出使用独立 `ExportJob`，创建任务时固化 SQLite 只读快照，文件位于 `db/exports` 并保留 24 小时。
- 工作簿包含 8 类逻辑工作表：导出元数据、数据源、文章数据、未入库条目、关键词、候选关键词、抓取日志 ID、推送日志；超过 Excel 行数上限时按同类表追加编号分表。
- 时间统一写为 `Asia/Shanghai` 的 Excel 日期值；超长单元格显式截断；敏感配置递归脱敏并按纯文本写入。
- 导出实现集中在 `src/lib/export/`，前端只通过受保护 API 管理任务。

## 管理后台

顶层导航只保留：

- `工作台`：Job 监控、技术恢复、文章搜索和统一的 Article / Event 详情抽屉。
- `设置`：概览、公开、源管理、关键词、AI 模型、提示词、推送、代理、账户、维护、备份和工具中心。

工作台负责任务状态与技术恢复；详情抽屉负责内容校准、Event 修正、公开决策和 Event 级人工推送。两者共用服务层，但不合并职责。

`设置 → 数据` 的 AI 重置会进入可恢复的 `maintenance` Job：每批 100 篇文章独立提交事务，并将游标写回 Job payload，进程重启后可继续。概览默认只查询近 1 周；选择“全部”时关闭自动刷新。Event 一致性修复单独消费 `EventDirty` 队列，不在聚类前重复全表扫描。

公开互动统计采用 `confirmed_request_count` 口径：客户端观察确认后的每次浏览请求计数，不等同于去重访客数；Event 累计值与按日趋势事实在同一事务中写入。历史 Event 一致性修复使用独立维护 Job，按 `phase/cursor` 分页续跑。

工作流租约、续租和取消轮询位于 `src/lib/execution-lease.ts`；Excel 导出分页位于 `src/lib/export/export-paging.ts`；工作台阶段常量位于 `src/components/crawl-log/workflow.ts`，编排文件只负责组合业务边界。CI 在生产构建后启动临时服务，执行登录、公开资讯、工具可用性和加密备份四项浏览器冒烟用例。

## 项目目录

```text
src/app/                 页面、Route Handler、robots 和 sitemap
src/components/          公开端与管理后台 UI
src/features/            浏览器端 API 客户端
src/contracts/           前后端共享 DTO 与状态契约
src/lib/                 服务、流水线、调度、公开、推送与导出逻辑
prisma/                  Schema、seed 和有序 migration 链
tests/                   Vitest 测试
scripts/                 生产初始化、自动部署和数据库维护脚本
bat/                     Windows 初始化、部署打包与运维说明
.github/workflows/       CI 与生产部署工作流
docs/                    公开端设计参考与阶段性设计资料
```

## 本地运行

环境要求：Node.js >= 20.9.0、npm >= 10。本服务器与 CI 使用 `.nvmrc` 固定到 Node.js 20.20.2，避免开发和部署使用不同的大版本。

```bash
mkdir -p db
if [ ! -f .env ]; then cp .env.example .env; fi
npm ci
npm run db:migrate:deploy
npm run db:generate
npm run db:seed
npm run db:optimize
npm run dev
```

访问 `http://localhost:3011`。

以上命令适用于 Linux/macOS；Windows 可使用 `bat/本地一键初始化.bat` 完成数据库和依赖初始化。开发服务会启动数据库调度器，同一 SQLite 数据库不要同时运行多个 `npm run dev` 实例。

本服务器通过公网 IP 远程开发时，访问 `http://43.166.0.19:3011`；`next.config.ts` 已允许该开发来源的 HMR 和字体资源。若公网 IP 变化，需要同步更新 `allowedDevOrigins` 后重启开发服务。

## 配置

```env
DATABASE_URL=file:../db/custom.db
API_TOKEN=
SETTINGS_ENCRYPTION_KEY=
NEXT_PUBLIC_SITE_URL=https://hot.kfxz.cn
```

- `DATABASE_URL`：固定使用项目目录下 `db/custom.db` 对应的 Prisma 相对路径。
- `API_TOKEN`：后台和受保护 API 的令牌；生产环境必填。
- `SETTINGS_ENCRYPTION_KEY`：敏感设置加密密钥；生产环境必填且部署间保持不变。
- `NEXT_PUBLIC_SITE_URL`：canonical、Open Graph、robots 与 sitemap 使用的站点地址；本地可留空或使用 `http://localhost:3011`，生产必须配置正式 HTTPS 地址。不要把本地 `.env` 直接用于生产。
- `OUTBOUND_PROXY_URL`：可选，全局 HTTP/HTTPS 出站代理；设置页保存值优先。代理会用于项目共享 HTTP 层的来源抓取、AI、模型列表和 Webhook 请求，公共代理不适合承载敏感数据。

### 代理与测速

设置页的“获取并测速全部”会优先保留此前验证过的 6 个历史兜底节点，再从 [RelayGlass](https://github.com/relayglass/free-proxy-list)、[Proxifly](https://github.com/proxifly/free-proxy-list) 和 [TheSpeedX](https://github.com/TheSpeedX/PROXY-List) 的公开列表补充候选，服务端去重后最多测试 24 个节点、同时测试 6 个。历史节点会随发布/重启保留，但每次仍需按当前目标重新测速；动态列表缓存 5 分钟，刷新失败时沿用上次候选。单节点测试包含目标页面响应体读取并有 8 秒总超时。测速通过后再点击“使用最快”并保存。公开免费代理可能随时失效，禁止传输密钥、Webhook、登录态或其他敏感数据。

### 配置 OpenCode Zen 免费模型

项目通过 OpenAI 兼容接口接入 OpenCode Zen，默认 API 地址为 `https://opencode.ai/zen/v1`。在后台进入 `设置 → AI 模型`，选择 `OpenCode (免费)` 并填写 API Key；模型列表会从官方 `GET /zen/v1/models` 动态读取，接口不可用时使用内置兜底。项目只允许 OpenCode 免费模型，免费模型请求会自动串行、间隔约 4 秒，收到 429 后尊重 `Retry-After` 并暂停后续请求，不自动重复发送。OpenCode 官方部分免费模型使用 `/chat/completions`，Contributor Free 使用 `/responses`，项目会按模型自动选择协议。免费模型为限时活动，且部分模型可能将请求内容用于改进模型，请勿提交敏感内容。API Key 由设置系统加密保存，不要写入 `.env`、代码或 Git。

模型列表与价格以 OpenCode 官方文档为准：<https://opencode.ai/docs/zh-cn/zen>；模型发现接口：<https://opencode.ai/zen/v1/models>。

### 配置 OpenRouter 免费模型

项目通过 OpenAI 兼容接口接入 OpenRouter，不需要额外安装 SDK。在后台进入 `设置 → AI 模型`，选择 `OpenRouter (免费模型)`，填写你自己的 API Key；默认 API 地址为 `https://openrouter.ai/api/v1`，默认模型为 `openrouter/free`。模型按钮会从官方 `GET /api/v1/models` 动态读取文本输出、输入与输出价格均为 0 的免费模型，并保留 `openrouter/free` 作为兜底；OpenRouter 的免费模型列表会变化，可点击“刷新免费模型”。免费模型存在速率限制。项目会对 OpenRouter 免费请求自动串行、每次间隔约 4 秒，收到 429 后停止本次自动重试并进入冷却，避免突发请求反复消耗额度。API Key 由设置系统加密保存，不要写入 `.env`、代码或 Git。

这类保护只能避免短时间突发，不能绕过 OpenRouter 的每日额度；官方 FAQ 当前说明免费账户通常为每天 50 次，购买至少 10 美元额度后为每天 1000 次。积压文章超过每日额度时，AI 队列会保留为待处理，等待后续恢复，不会继续盲目请求。

申请或管理 API Key：<https://openrouter.ai/keys>；接口说明：<https://openrouter.ai/docs/quickstart>；模型列表说明：<https://openrouter.ai/docs/api/api-reference/models/get-models>。

本服务器当前使用新建的开发数据库 `db/custom.db`，初始化只执行 migration 和 seed，不自动恢复旧数据库。旧数据迁移需要单独准备经过确认的备份文件。

## 常用命令

```bash
npm run dev                 # 开发服务，端口 3011
npm run build               # 生产构建
npm run start               # 生产服务，端口 3011
npm run lint                # ESLint
npm run typecheck           # TypeScript 类型检查
npm test                    # 默认测试，不含 migration 冒烟
npm run test:critical       # 核心业务测试
npm run test:migrations     # 空 SQLite migration 测试
npm run test:all            # 默认测试 + migration 测试
npm run verify              # lint + typecheck + 全测试 + build
```

数据库命令：

```bash
npm run db:migrate:status
npm run db:migrate:deploy
npm run db:generate
npm run db:seed
npm run db:optimize
npm run db:cleanup-logs
```

`prisma/migrations/` 的有序目录是数据库结构事实源。生产只使用 `db:migrate:deploy`；项目不维护旧 migration 历史的兼容桥。

## 部署

完整操作见 [`bat/部署和更新方法.txt`](bat/部署和更新方法.txt)，Nginx 模板见 [`bat/本项目的nginx.txt`](bat/本项目的nginx.txt)。生产初始化脚本是 [`scripts/init-production.sh`](scripts/init-production.sh)，日常发布脚本是 [`scripts/deploy-production.sh`](scripts/deploy-production.sh)；两者依赖 PM2、SQLite 和反向代理环境。初始化脚本会重建生产依赖和数据库，执行前必须确认备份与数据范围。

当前仓库包含 GitHub Actions workflow，日常发布路径为：

```text
推送或合并 master → CI → CI 成功 → Deploy production → 健康检查并核对线上 Git revision
```

`Deploy production` 作为 CI 的复用 Job，仅在质量检查、迁移冒烟、生产构建和 E2E 全部成功后执行；也可从 GitHub Actions 手动运行。部署所需的 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY` 及可选的 `DEPLOY_PORT`、`DEPLOY_KNOWN_HOSTS` 应配置在 `production` Environment 的 Secrets/Variables 中。

发布脚本会在版本化 release 目录安装依赖并构建，再校验 migration 历史兼容性（允许当前发布包中的待执行 migration，拒绝未知或未完成记录）、停止 PM2、备份 SQLite、应用 migration，最后原子切换 `current` 软链、启动单实例并检查包含 SQLite 可访问性的健康接口与 CSS 资源。GitHub Actions 随部署包写入目标 Git revision，并在外部健康检查后核对线上 revision。旧 release 默认保留 5 个，普通部署失败时会恢复数据库备份和旧版本；生产重置不提供自动回滚。

手动 `reset_production=yes` 会在不备份的情况下删除生产 SQLite，并从当前 migration 与 seed 全新初始化。只有在明确接受丢失生产数据时才可使用；生产重置失败不提供自动数据库回滚。

## 文档边界

- `README.md`：当前产品、架构、运行与部署入口。
- `AGENTS.md`：实现边界、代码规范和交付约束。
- `CONTEXT.md`：统一业务术语，不记录实现细节。
- `docs/design/DESIGN.md`：公开端视觉参考，不作为产品或架构事实源。
- `bat/部署和更新方法.txt`：可直接执行的生产运维步骤。
- `scripts/init-production.sh`：生产首次初始化或明确批准后的重建入口。
- `scripts/deploy-production.sh`：保留 release、备份 SQLite 和原子切换版本的发布入口。

功能、命令、migration、部署流程或统一术语变化时，同步更新对应文档；已完成的阶段性方案不长期保留为第二套事实源。

## 安全与运行约束

- 不提交 `.env`、API Token、Webhook、SSH 私钥、SQLite 数据、导出文件或部署包。
- 完整备份文件使用用户设置的保护密码加密可编辑密钥和 Webhook；密码丢失无法恢复，旧的明文 JSON 备份不再支持导入。关键词表格和文章 Excel 导出不包含这些敏感设置。
- 生产禁止使用 `prisma db push`、`db:danger:reset`；`db:seed` 仅用于首次初始化或明确重建。
- migration、重建和危险数据清理前先确认数据库备份有效。
- PM2 仅运行一个 `hot` 实例，不使用 cluster 或 `-i max`；Job Runner 另有数据库租约，防止部署重叠或误起多进程时重复执行任务，但不把 SQLite 当作横向扩展方案。
- Nginx 将 `/` 和 `/_next/` 代理到 `127.0.0.1:3011`；不要直接映射 `.next/static`。
- 普通应用更新不清理服务器全局 Nginx 缓存，也不 reload Nginx。
