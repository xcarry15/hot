# Hot2

Hot2 是面向餐饮与零售行业的新闻聚合、AI 分析、事件去重、人工审核和飞书推送系统。

```text
数据源采集 → 正文处理与筛选 → AI 分析 → Event 聚类 → 人工审核 → 公开展示 / 飞书推送
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

Windows 需要完全重建本地环境时，可直接双击 `bat/本地一键初始化.bat`。入口使用纯英文 PowerShell 脚本执行，避免 CMD 中文编码问题；该操作会删除本地 SQLite 和历史数据。

## 环境变量

```env
DATABASE_URL=file:../db/custom.db
API_TOKEN=
NEXT_PUBLIC_SITE_URL=https://hot.kfxz.cn
```

- `DATABASE_URL`：SQLite 路径，默认指向 `db/custom.db`。
- `API_TOKEN`：生产环境必填，用于后台登录和受保护 API；未配置时生产环境拒绝访问。
- `NEXT_PUBLIC_SITE_URL`：正式站点地址，用于 canonical、Open Graph 和 sitemap。

公开首页、公开文章 API 和健康检查保持匿名访问；后台页面及其他 API 受 Token 会话保护。

## 核心架构

项目采用单进程模块化单体。Next.js 同时承载页面、API、调度器和任务执行器；生产环境只运行一个 PM2 实例，不需要 Redis、消息队列或独立 Worker。

### 数据模型

- `Source`：采集源及解析配置。
- `Article`：原始报道、正文、AI 结果和人工校准记录。
- `Event`：同一事件的聚合单元，也是公开展示和推送去重的唯一边界。
- `Job`：批量或单篇任务的状态、进度、租约与取消事实。
- `PushDelivery`：每个 Event 对每个推送目标的最新投递状态；`PushLog` 只保存历史审计。
- `DiscardedItem`：未进入 Article 的采集结果和重试记录。
- `Setting`、`Keyword`、`PushTarget`：运行配置、筛选词和推送目标。

`Article` 与 `Event` 的职责必须保持分离：

- AI 必须先提取 `subjects / action / object`，应用再确定性生成 `eventKey`。
- Article 保存内容处理、AI 与人工校准结果。
- Event 选择唯一代表 Article，并决定公开和推送状态。
- 非代表 Article 不公开、不推送。
- `Event.publicStatus` 是公开状态的事实源。

### 处理流水线

| 阶段 | 代码 | 职责 |
| --- | --- | --- |
| collect | `src/lib/pipeline/collect.ts` | 读取数据源并写入采集结果 |
| process | `src/lib/pipeline/process.ts` | 获取正文、清洗内容、关键词筛选 |
| ai | `src/lib/pipeline/analyze.ts` | 生成摘要、评分和结构化事件身份 |
| cluster | `src/lib/pipeline/cluster.ts` | 把 Article 归入 Event 或标记待复核 |
| push | `src/lib/pipeline/push-bridge.ts` | 按 Event 和目标执行推送 |

`src/lib/execution.ts` 是 Job 的统一编排入口。批量阶段会分块处理全部当前积压；分块大小不是任务完成边界。调度器位于 `src/lib/scheduler.ts`，自动采集默认关闭，配置从数据库读取。

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

## 代码结构

```text
src/app/                 页面、Route Handler、robots 和 sitemap
src/components/          公开端与管理后台 UI
src/features/            浏览器端 API 客户端
src/contracts/           前后端共享 DTO 和领域契约
src/lib/                 服务、流水线、调度、公开和推送逻辑
prisma/                  Schema、seed 和有序 migration
tests/                   Vitest 测试
scripts/                 生产初始化、部署和数据库维护脚本
bat/                     Windows 初始化、打包和运维文档
.github/workflows/        CI 与生产部署流程
```

职责约束：

- Route Handler 只处理鉴权、参数和响应转换，业务规则放在 `src/lib/`。
- API 不直接向浏览器返回 Prisma Model，应通过 `src/contracts/` 中的 DTO。
- 设置定义集中在 `src/lib/settings-catalog.ts`。
- Event 校准集中在 `src/lib/event-service.ts`。
- 人工审核集中在 `src/lib/review-service.ts`。
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

日常生产部署禁止使用 `db:push` 或 `db:reset`。本项目不为历史业务数据维护兼容层；结构或规则变化按重新采集新数据处理。

## 管理后台

后台导航收敛为：

- `工作台`：任务监控、技术恢复、Article 校准、Event 修正、公开决策和人工推送。
- `设置`：数据源、关键词、AI、评分、推送目标、调度和数据维护。

技术失败由任务区域处理；内容判断和 Event 校准由文章详情抽屉处理。两者共享同一工作台，但服务层职责不合并。

单篇恢复统一使用 `POST /api/articles/[id]/workflow`：

- `retry`：只重试当前可恢复的失败阶段。
- `regenerate`：从指定阶段重置并重新计算。

## 性能边界

当前规模采用轻量优化：

- SQLite WAL、必要索引和短事务。
- 公开列表使用稳定游标分页和有界短缓存。
- 后台详情按需加载，轮询在页面隐藏时暂停。
- Job、公开统计和技术待办使用短缓存合并重复读取。
- 批处理按固定 chunk 消费全部积压，避免一次加载无限数据。

在有明确性能数据前，不引入 Redis、消息队列、微服务或多实例 PM2。

## 测试与自动部署

GitHub Actions 配置：

- `.github/workflows/ci.yml`：`master` push、Pull Request 或手动触发；执行 lint、类型检查、单元测试、migration smoke 和生产构建。
- `.github/workflows/deploy.yml`：`master` 的 CI 成功后自动部署生产；也支持手动重新部署。

部署流程会停止 PM2、备份 SQLite、同步并删除旧代码、安装依赖、应用 migration、构建、以单实例启动 PM2，并检查 `/api/health`。服务器上的 `.env` 和 `db/` 不会被发布包覆盖。

服务器全新初始化使用：

```bash
cd /www/wwwroot/hot.kfxz.cn
bash scripts/init-production.sh
```

完整步骤见 `bat/部署和更新方法.txt`，Nginx 模板见 `bat/本项目的nginx.txt`。

## 安全规则

- 不提交 `.env`、API Token、Webhook、SSH 私钥、SQLite 数据或部署压缩包。
- 生产环境必须设置强随机 `API_TOKEN`。
- PM2 只能运行一个 `h2-hot2` 实例，禁止 `-i max` 和 cluster 模式。
- 普通发布不清理服务器全局 Nginx 缓存，也不 reload Nginx。
- migration 前先备份数据库；出现 drift 时停止操作，不要 reset 用户数据库。
