# 开发选址助手

开发选址助手是面向餐饮与零售行业的新闻采集、正文处理、AI 分析、事件聚类、公开展示和飞书推送系统。

公开站点核心内容为精选行业资讯与选址、地图、数据分析工具。

```text
采集 → 正文处理/筛选 → AI 分析 → Event 聚类 → 公开展示/推送
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

访问：

- 公开站点：`http://localhost:3011`
- 管理后台：`http://localhost:3011/admin`
- 公开文章：`/news/[id]`（`id` 为 Event ID）
- 工具中心：`/tools`（选址、地理位置、数据分析与文件工具入口）
- 关于本站：`/about`（公开站点的工作机制与来源说明）

Windows 本地需要重新创建数据库时，双击 `bat/本地一键初始化.bat`；依赖或 lock 文件变化时使用 `bat/本地一键初始化.bat -RefreshDependencies`。该操作会清理本地 SQLite 和构建产物，不保留本地历史数据。

## 配置

`.env` 的核心配置：

```env
DATABASE_URL=file:../db/custom.db
API_TOKEN=
SETTINGS_ENCRYPTION_KEY=
NEXT_PUBLIC_SITE_URL=https://hot.kfxz.cn
```

- `DATABASE_URL`：SQLite 数据库位置，默认位于项目目录外的 `db/custom.db`。
- `API_TOKEN`：后台和受保护 API 的令牌；生产环境必填。
- `SETTINGS_ENCRYPTION_KEY`：加密 Webhook 等敏感配置；生产环境必填，部署间必须保持不变。
- `NEXT_PUBLIC_SITE_URL`：正式站点地址，用于 canonical、Open Graph 和 sitemap。

公开首页、公开文章 API 和健康检查匿名可访问；后台及其他 API 使用 Token 会话保护。

## 核心边界

- `Article` 保存来源文章、正文、AI 结果和人工校准记录。
- `Event` 是事件聚合、公开展示和推送去重的唯一边界；每个 Event 只有一个代表 Article。
- 非代表 Article 不公开、不推送；`Event.publicStatus` 是公开状态事实源。
- AI 先提取 `subjects / action / object`，应用再确定性生成 `eventKey`；聚类不重复调用 AI。
- 技术失败进入有限自动恢复队列；内容校准、Event 修正、公开决策和人工推送由文章详情抽屉负责。
- 管理后台只保留 `工作台` 和 `设置`：工作台负责任务监控与技术恢复，设置负责数据源、关键词、AI、评分、推送和调度配置。
- 工具中心 `/tools` 是独立的公开工具目录，使用 `ToolDirectoryItem` 数据表展示 5 个分类的外部工具入口；首次初始化由 `prisma/seed.ts` 从 `src/components/public-tools/tool-catalog.ts` 的迁移快照写入 19 张卡片，运行时由 `src/lib/tool-directory-service.ts` 读取。工具入口不再维护打开/下载类型；状态固定为正常、内测中、维护中、即将上线、停用，仅正常和内测中且具有公网 HTTPS 链接的卡片可点击，其他状态保留展示但不可点击；标签固定为免费、付费、热门、有更新、最新。后台设置中的“工具中心”标签提供受保护的新增、编辑、排序、状态、标签、下架和恢复管理，图标选择器默认折叠并提供项目、数据、POI、地图、商业等备用图标，保存后通过公开目录缓存失效立即生效。
- 设置的数据维护提供受保护的全量 Excel 导出：导出任务独立于抓取 Job，工作簿严格只包含 `导出元数据`、`数据源`、`文章数据`、`未入库条目`、`关键词`、`候选关键词`、`抓取日志 ID`、`推送日志` 8 个 Sheet；“文章数据”额外汇总来源开关、Event 权威公开/复核状态、代表文章、实际命中关键词和当前处理阻断原因，全文搜索索引按标题、摘要、品牌/主体、事件标识顺序拆分并复用现有列，原始评分紧邻综合评分前。所有时间列统一写成中国标准时间的 Excel 可识别日期值，显示格式为 `yyyy-mm-dd hh:mm:ss`，不再额外导出 ISO 时间字段。当前白名单不再生成正文/超长字段分片 Sheet，保留字段超过 Excel 单元格上限时追加明确截断标记；任务创建时固化 SQLite 只读快照，文件只在服务器公开目录外保留 24 小时。

流水线实现位于：

| 阶段 | 主要代码 | 作用 |
| --- | --- | --- |
| collect | `src/lib/pipeline/collect.ts` | 读取数据源并写入采集结果 |
| process | `src/lib/pipeline/process.ts` | 获取、清洗正文并执行关键词筛选 |
| ai | `src/lib/pipeline/analyze.ts` | 生成摘要、评分和事件身份 |
| cluster | `src/lib/pipeline/cluster.ts` | 归入 Event 或建立独立 Event |
| push | `src/lib/pipeline/push-bridge.ts` | 按 Event 和目标执行推送 |

单篇恢复统一使用 `POST /api/articles/[id]/workflow`：`retry` 只重试可恢复失败阶段，`regenerate` 从指定阶段重置并重算。批处理会持续消费当前积压，chunk 大小不是完成边界。

批量推送由调度器每分钟检查并使用数据库 Job 标记做补偿：配置时间点被其他任务占用时会在后续 tick 补发，Event 的 `nextPushRetryAt` 到期后会自动重试；每日完成日期只在推送 Job 真正 `succeeded` 后写入。飞书 HTTP 2xx 还必须包含业务 `code`（或 `StatusCode`）为 0 才记为成功。自动化调度遵守设置中的 `crawl_quiet_start` / `crawl_quiet_end`（按 `Asia/Shanghai`，支持跨午夜，默认 22:00–08:00），时段内不启动自动抓取、技术恢复或自动推送；手动操作不受影响。

## 管理功能

- 工作台：采集任务、全部/处理中/正常/异常/待操作筛选、技术失败恢复、文章搜索和文章详情抽屉；处理中按待正文、待 AI、待聚类、待推送细分，正常按已公开、已推送细分，异常按技术恢复/失败、门槛、无价值、软文和重复细分；正常只统计已公开的 Event 代表文章，待复核、低分析置信和已忽略属于可与正常/异常重叠的人工关注快捷入口。已公开和已推送统计固定显示在任务头部，“今日”按 Asia/Shanghai 自然日筛选；数据源“本次新增”统计最近一次采集中实际新建的 Article，不包含重复或已丢弃条目。工作台 UI 只通过 `src/features/*-api.client.ts` 访问浏览器端 API，文章详情抽屉的 Event DTO 集中在 `src/contracts/events.ts`。
- 概览默认使用近 1 周窗口，支持“全部”、今天、近 3 天、近 1 周和近 30 天时间筛选；日期统一按 Asia/Shanghai 的自然日计算。“全部”不设置时间下限，需显式选择以避免首次打开概览就加载全量历史。
- 设置：数据源、关键词、AI、评分、推送目标、自动抓取、数据维护和提示词；数据维护包含配置备份、危险清理、数据库维护和“文章 Excel 导出”。Excel 导出支持按时间、来源、处理状态、Event、代表文章、公开/推送状态筛选，日期无时区输入按 Asia/Shanghai 解释，已推送按快照内启用目标的最新 PushDelivery 判断，生成上述 8 个固定工作表，名称、列标题、元数据和状态说明均为中文，并在“文章数据”中补充来源门禁、Event 权威状态、实际关键词和处理结论/阻断原因；导出任务列表提供进度、取消、重试和下载。导出文件使用后台鉴权下载，过期后自动清理。概览按“抓取记录 / 推送记录”和“公开浏览 / 每日文章动态”两行排列，提供公开浏览量 Top 20 文章并展示文章发布时间和评分，点击可直接跳转工作台打开文章详情，同时按日展示新增、公开和推送数量。浏览与原文点击以 Event 为事实主体，按发生日持久化；公开和推送按 Event 的实际动作时间归档，所有图表与时间范围同步。旧 Article 累计互动不反推到新日明细，发布本迁移后从新互动数据重新计量。
- 设置：数据源、关键词、AI、评分、推送目标、自动抓取、数据维护和提示词；数据维护包含配置备份、危险清理、数据库维护和“文章 Excel 导出”。Excel 导出支持按时间、来源、处理状态、Event、代表文章、公开/推送状态筛选，日期无时区输入按 Asia/Shanghai 解释，已推送按快照内启用目标的最新 PushDelivery 判断，生成上述 8 个固定工作表，名称、列标题、元数据和状态说明均为中文，并在“文章数据”中补充来源门禁、Event 权威状态、实际关键词和处理结论/阻断原因；导出任务列表提供进度、取消、重试和下载。导出文件使用后台鉴权下载，过期后自动清理。概览按“抓取记录 / 推送记录”和“公开浏览 / 每日文章动态”两行排列，提供公开浏览量 Top 20 文章并展示文章发布时间和评分，点击可直接跳转工作台打开文章详情，同时按日展示新增、公开和推送数量。浏览与原文点击以 Event 为事实主体，按发生日持久化；公开和推送按 Event 的实际动作时间归档，所有图表与时间范围同步。旧 Article 累计互动不反推到新日明细，发布本迁移后从新互动数据重新计量。
- 设置目录中的默认参数已与当前本地运行配置对齐（包括 AI 并发和当前提示词）；API Key、Webhook 等敏感值永不写入代码默认值，继续由本地安全配置保存。
- 关键词支持 XLSX 导入/导出；工作簿包含正式关键词及候选词状态 Sheet，黑名单命中后在入库前拦截。工作台从“未命中关键词”手动采集时，关键词保存与当前记录恢复通过同一事务完成，只移除当前记录，不清空其他未命中记录。
- HTML 数据源会保留列表页或文章 URL 中可确定的发布时间；站点仅展示“刚刚/昨天”等相对时间时，自动使用 URL 中的 `YYYYMMDD` 作为文章内容排序的日期兜底。工作台按 Article 进入系统的 `createdAt` 截取最近采集窗口，默认最多 400 条；窗口内各数据源按文章 `publishedAt` 倒序展示，无发布时间时回退到 `createdAt`。窗口外历史文章通过文章库服务端分页搜索，技术失败和自动重试项按 Article ID 额外补入，不受窗口截断影响。
- 提示词版本管理集中提供当前提示词备份导入/导出；导入备份会同步创建一个可回退的提示词版本，并支持 System 与评判块的命名版本、单个版本导出/对比/载入。
- 公开与推送以 Event 代表文章、来源开关、AI/聚类完成状态和相应策略为门禁；`needs_review` 不得公开或推送。事件候选无法自动确认时必须保留为 `needs_review/pending`，包括低置信度但相同 `eventKey` 的冲突；候选审计不是可绕过门禁的普通提示。

## 目录

```text
src/app/                 页面、Route Handler、robots 和 sitemap
src/components/          公开端与管理后台 UI（`public-tools/` 为工具目录模块）
src/features/            浏览器端 API 客户端
src/contracts/           前后端共享 DTO 和状态契约
src/lib/                 服务、流水线、调度、公开和推送逻辑（含工具目录服务）
prisma/                  Schema、seed 和当前 baseline migration
tests/                   Vitest 测试
scripts/                 生产初始化、部署和数据库维护脚本
bat/                     Windows 初始化、打包和部署说明
.github/workflows/       CI 与生产部署
```

Route Handler 只负责鉴权、参数和响应转换；业务规则集中在 `src/lib/`，前后端数据通过 `src/contracts/` 传递。设置定义集中在 `src/lib/settings-catalog.ts`，公开规则和推送规则不得复制到 React 组件。Excel 导出查询、创建时快照、脱敏、正文/长字段分片、工作簿生成和文件保留逻辑集中在 `src/lib/export/`，不得在设置组件中直接访问 Prisma。

## 常用命令

```bash
npm run dev                 # 开发服务
npm run build               # 生产构建
npm run start               # 生产启动
npm run lint                # ESLint
npm run typecheck           # TypeScript 类型检查
npm test                    # 默认测试（不含 migration 冒烟）
npm run test:critical       # 核心业务测试
npm run test:migrations     # 空 SQLite migration 测试
npm run test:all            # 默认测试 + migration 测试
npm run verify              # lint + typecheck + 全测试 + build
```

数据库维护：

```bash
npm run db:migrate:status
npm run db:migrate:deploy
npm run db:generate
npm run db:seed
npm run db:optimize
npm run db:cleanup-logs
```

## 部署

生产部署的完整操作、首次初始化、日常更新和故障处理见 [`bat/部署和更新方法.txt`](bat/部署和更新方法.txt)。Nginx 配置模板见 [`bat/本项目的nginx.txt`](bat/本项目的nginx.txt)。

日常流程：

```text
推送/合并 master → GitHub Actions CI → CI 成功 → 自动备份数据库并部署
```

自动部署由 `.github/workflows/deploy.yml` 调用 `scripts/deploy-production.sh` 完成：验证当前 migration、备份 SQLite、`rsync --delete` 同步代码、安装依赖、应用 migration、构建、单实例启动 PM2，并检查健康接口和 Next.js CSS。部署会保留服务器上的 `.env` 和 `db/`；不会自动回滚代码或 migration。只有在明确授权时，才可手动运行该工作流并选择 `reset_production=yes`；该选项会删除现有生产 SQLite 且不备份，再从 baseline migration 和 seed 重新初始化。

生产发布以 release 包中 `prisma/migrations` 目录的完整 migration 集合为准。发现线上 migration 历史不匹配时，普通部署会拒绝继续；项目不维护旧数据库兼容层。若确认放弃现有生产数据，可手动运行 `Deploy production` 并选择 `reset_production=yes` 重新初始化。

## 安全与运行约束

- 不提交 `.env`、API Token、Webhook、SSH 私钥、SQLite 数据或部署包。
- Excel 导出不包含设置真实值、API Key、Webhook、Cookie、Authorization、`secretRef` 或认证 Header；导出文件位于公开静态目录之外并自动过期。
- 生产环境禁止使用 `prisma db push`、`db:danger:reset`；`db:seed` 只用于初始化或明确的全新重建。
- PM2 只运行一个 `h2-hot2` 实例，禁止 cluster 或 `-i max`。
- migration 或重建前先备份 SQLite。
- Nginx 将 `/` 和 `/_next/` 代理到 `127.0.0.1:3011`；不要用 `alias` 直接映射 `.next/static`。
- 普通应用更新不清理服务器全局 Nginx 缓存，也不需要 reload Nginx。
