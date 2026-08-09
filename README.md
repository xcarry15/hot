# 开发选址助手

开发选址助手面向餐饮与零售行业，提供经过筛选的行业资讯，以及选址、地图和数据分析工具。

后台负责资讯采集、正文处理、AI 分析、事件聚类、公开展示和飞书推送：

```text
采集 → 正文处理与筛选 → AI 分析 → Event 聚类 → 公开展示 / 推送
```

技术栈：Next.js 16、React 19、TypeScript、Prisma 6、SQLite、Vitest。

> 对外产品名统一为“开发选址助手”。`hot2`、`h2-hot2` 仅保留为 npm 包、PM2 应用、部署文件等内部技术标识。

## 产品入口

- `/`：精选行业资讯列表。
- `/news/[id]`：公开资讯详情，`id` 为 Event ID。
- `/tools`：选址、地理位置、数据分析和文件工具目录。
- `/about`：产品说明与联系入口。
- `/admin`：Token 会话保护的管理后台。
- `/api/health`：匿名健康检查。

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
- 技术失败经过有限自动重试后进入人工处理；不会通过删除 Article 来隐藏失败。
- 调度器按数据库 Job 状态运行，并遵守 `Asia/Shanghai` 的静默时段；手动操作不受静默时段限制。
- `PushDelivery` 保存当前目标投递状态，`PushLog` 只作为历史审计。

### 工具目录

- 运行时数据来自 `ToolDirectoryItem` 与 `ToolDirectoryCategory`，公开端不以静态目录作降级数据源。
- 数据库为空时，`prisma/seed.ts` 才会写入 `src/components/public-tools/tool-catalog.ts` 中的初始化快照和默认分类；之后由后台维护。
- 分类、展示标签、工具状态和图标契约集中在 `src/contracts/tool-directory.ts`；后台编辑时状态选项与展示标签合并为同一组标签，前四项互斥。
- 仅 `active` 且具有公网 HTTPS 地址的条目可点击；其他未归档条目继续展示但不可打开，公开数据中也不会下发其 URL。
- `设置 → 工具中心` 提供工具新增、编辑、排序、归档和恢复，以及分类改名和排序；保存后会失效公开目录缓存。

### 备份、导出与维护

- `设置 → 备份` 是唯一的数据迁移入口：完整 JSON 一次包含可编辑设置、提示词版本、数据源、关键词与候选词、工具目录；旧的设置、提示词和工具独立备份接口不再保留。
- 完整恢复先校验全部模块，再在同一数据库事务中覆盖配置；数据源运行状态重新初始化，关键词过滤临时结论失效，并统一安排评分或公开状态重建。备份不包含文章正文、运行日志和任务历史。
- 关键词 XLSX 批量编辑与文章 Excel 归档也集中在 `设置 → 备份`；关键词 XLSX 与完整 JSON 共用正式关键词、候选词、出现次数和示例标题字段，候选词状态由工作表名称表达，不再重复保存“状态”列。前者是专项迁移格式，后者只读、不可用于恢复完整配置。
- `设置 → 维护` 只负责日志清理、文章清理和数据库压缩，不再混放导入导出操作。
- Excel 导出使用独立 `ExportJob`，创建任务时固化 SQLite 只读快照，文件位于 `db/exports` 并保留 24 小时。
- 工作簿包含 8 类逻辑工作表：导出元数据、数据源、文章数据、未入库条目、关键词、候选关键词、抓取日志 ID、推送日志；超过 Excel 行数上限时按同类表追加编号分表。
- 时间统一写为 `Asia/Shanghai` 的 Excel 日期值；超长单元格显式截断；敏感配置递归脱敏并按纯文本写入。
- 导出实现集中在 `src/lib/export/`，前端只通过受保护 API 管理任务。

## 管理后台

顶层导航只保留：

- `工作台`：Job 监控、技术恢复、文章搜索和统一的 Article / Event 详情抽屉。
- `设置`：概览、公开、源管理、关键词、AI 模型、提示词、推送、账户、维护、备份和工具中心。

工作台负责任务状态与技术恢复；详情抽屉负责内容校准、Event 修正、公开决策和 Event 级人工推送。两者共用服务层，但不合并职责。

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
```

## 本地运行

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

访问 `http://localhost:3011`。

需要重新创建本地数据库时，双击 `bat/本地一键初始化.bat` 并输入 `RESET`。依赖或 lock 文件变化时使用：

```text
bat/本地一键初始化.bat -RefreshDependencies
```

该流程会删除本地 SQLite 与 `.next`，但保留 `.env`；不会运行测试或生产构建。

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
- `NEXT_PUBLIC_SITE_URL`：canonical、Open Graph、robots 与 sitemap 使用的正式站点地址。

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

完整操作见 [`bat/部署和更新方法.txt`](bat/部署和更新方法.txt)，Nginx 模板见 [`bat/本项目的nginx.txt`](bat/本项目的nginx.txt)。

日常发布路径：

```text
推送或合并 master → CI → CI 成功 → Deploy production → 健康检查
```

自动部署由 `.github/workflows/deploy.yml` 调用 `scripts/deploy-production.sh`：校验 migration 历史、停止 PM2、备份 SQLite、`rsync --delete` 同步、安装依赖、应用 migration、构建、单实例启动并检查健康接口与 CSS 资源。

手动 `reset_production=yes` 会在不备份的情况下删除生产 SQLite，并从当前 migration 与 seed 全新初始化。只有在明确接受丢失生产数据时才可使用；部署不会自动回滚代码或 migration。

## 文档边界

- `README.md`：当前产品、架构、运行与部署入口。
- `AGENTS.md`：实现边界、代码规范和交付约束。
- `CONTEXT.md`：统一业务术语，不记录实现细节。
- `docs/design/DESIGN.md`：公开端视觉参考，不作为产品或架构事实源。
- `bat/部署和更新方法.txt`：可直接执行的生产运维步骤。

功能、命令、migration、部署流程或统一术语变化时，同步更新对应文档；已完成的阶段性方案不长期保留为第二套事实源。

## 安全与运行约束

- 不提交 `.env`、API Token、Webhook、SSH 私钥、SQLite 数据、导出文件或部署包。
- 完整 JSON 备份包含可编辑密钥和 Webhook，必须按敏感文件保管；关键词表格和文章 Excel 导出不包含这些明文设置。
- 生产禁止使用 `prisma db push`、`db:danger:reset`；`db:seed` 仅用于首次初始化或明确重建。
- migration、重建和危险数据清理前先确认数据库备份有效。
- PM2 仅运行一个 `h2-hot2` 实例，不使用 cluster 或 `-i max`。
- Nginx 将 `/` 和 `/_next/` 代理到 `127.0.0.1:3011`；不要直接映射 `.next/static`。
- 普通应用更新不清理服务器全局 Nginx 缓存，也不 reload Nginx。
