# Hot2

Hot2 是一个面向餐饮/零售行业的新闻聚合工具，自动完成：

```text
数据源采集 → 详情抓取 → 去重与关键词过滤 → AI 分析 → 飞书多 Webhook 推送
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

开发地址：`http://localhost:3011`

生产环境必须在 `.env` 设置 `API_TOKEN`。浏览器进入「设置 → 账户」填写同一个 token 后，才能访问或修改 API 数据。

## 生产部署

项目按 Prisma migration 发布，不使用 `prisma db push` 作为日常部署方式。完整流程见：

- `bat/部署和更新方法.txt`：新库、存量 db push 库切换、日常更新、日志维护
- `bat/本项目的nginx.txt`：宝塔 Nginx 反向代理模板

生产更新的核心命令：

```bash
npm install
npm run db:migrate:deploy
npm run db:generate
npm run build
pm2 delete h2-hot2 && pm2 start npm --name h2-hot2 -- start
```

部署包不包含 `.env`、`db/`、测试、`docs/` 和根目录开发说明（`README.md` / `CLAUDE.md` / `项目当前架构基线.md`）；`bat/` 中的部署/Nginx 文档会随包保留，便于服务器现场查阅。服务器上的配置与 SQLite 数据会保留。

## 当前架构与数据库

当前架构、API 归属、流水线、默认值和完整 migration 链以根目录
[`项目当前架构基线.md`](项目当前架构基线.md) 为准。部署时通过
`npm run db:migrate:deploy` 自动按序应用 `prisma/migrations/` 中的全部 migration，
不要在其他文档中重复维护 migration 清单。

历史上用 `db push` 维护过的存量库，首次切换前必须停服务并备份，然后执行：

```bash
npm run db:migrate:baseline
npm run db:migrate:deploy
npm run db:migrate:status
```

预检出现 drift 时应停止处理并人工检查，不要 reset 或覆盖数据库。

## 运维

```bash
npm run db:migrate:status
npm run db:cleanup-logs
pm2 status
pm2 logs h2-hot2
```

日志清理周期：FetchLog 30 天；PushLog 90 天但保留未完成投递的文章日志；completed/failed Job 30 天。清理不会删除文章、数据源或运行中的任务。

## 验证

```bash
npm run lint
npx tsc --noEmit
npm test
```

项目采用单进程全局单 Job。任务状态由 Job 表和 `/api/crawl-log/status` 的定时快照提供。
