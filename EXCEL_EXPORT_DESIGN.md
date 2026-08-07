# Excel 全量数据导出设计方案

## 1. 文档状态

- 状态：已确认，已实现（`codex/excel-export`）
- 目标：为管理后台提供全量文章及处理结果的 Excel 导出能力
- 入口：`设置 → 数据维护 → Excel 导出`
- 输出：一个多 Sheet 的 `.xlsx` 文件
- API：`/api/data-export` 及其任务操作/下载子路由

## 2. 目标与边界

导出系统中所有已入库文章及其完整处理结果，包括原文、品牌/主体、事件动作、摘要、评分、发布时间、来源链接、Event ID、公开状态、推送状态和相关审计信息。

“全部文章”包含所有 `Article`，不因以下状态被排除：

- 正文待抓取、正文失败
- AI 待处理、失败或跳过
- 聚类待处理、失败或 `needs_review`
- 重复、低价值、软文、已忽略或未公开
- 已被人工修正或更换代表文章

此外，未进入 `Article` 的抓取条目也要导出，包括 `DiscardedItem` 和 `DiscardedRetryAudit`，并明确标记为“未入库记录”。

不在本功能范围内：

- 公开端匿名下载
- 导出 API Key、Webhook、Cookie、Authorization、`secretRef` 等敏感值
- 补造数据库中不存在的历史 AI 尝试记录
- 把导出任务混入抓取流水线 Job

## 3. 工作簿结构

### 3.1 Sheet 清单

| Sheet | 内容 | 主键/关联字段 |
| --- | --- | --- |
| `ExportMeta` | 导出版本、生成时间、快照时间、筛选条件、各 Sheet 行数和错误数 | `exportJobId` |
| `Articles` | Article 全部普通字段、处理状态、AI 结果、人工校准、公开状态、统计字段 | `articleId` |
| `ArticleContent` | `rawContent`、`cleanContent`、`articleBody` 及超长 Article 字段的完整分片内容 | `articleId`、`contentType`、`chunkNo` |
| `LongTextChunks` | 其他 Sheet 超过 Excel 单元格限制的完整文本分片 | `sheetName`、`rowKey`、`field`、`chunkNo` |
| `Events` | Event 全部普通字段、代表文章、公开和推送状态 | `eventId` |
| `ArticleEventRelations` | 当前 Article/Event 关系、是否代表文章、代表选择方式 | `articleId`、`eventId` |
| `EventClusterAudits` | 聚类、移动、合并、代表文章变更等审计 | `auditId` |
| `Sources` | 数据源配置和生命周期信息 | `sourceId` |
| `FetchLogs` | 数据源抓取结果、条数和错误 | `fetchLogId` |
| `Jobs` | 抓取流水线 Job 及进度、状态、错误 | `jobId` |
| `PushTargets` | 推送目标的安全字段 | `targetId` |
| `PushDeliveries` | 当前有效的目标投递状态 | `deliveryId` |
| `PushLogs` | 历史推送审计 | `pushLogId` |
| `EventInteractionDaily` | Event 按日期和来源的互动统计 | `eventId`、`sourceId`、`dateKey` |
| `KeywordHits` | 文章命中的关键词关系 | `articleId`、`keywordId` |
| `Keywords` | 关键词及分类 | `keywordId` |
| `KeywordCandidates` | 候选关键词及处理状态 | `candidateId` |
| `TuningSuggestions` | 人工校准产生的调优建议 | `suggestionId` |
| `DiscardedItems` | 未入库条目及拦截/去重原因 | `discardedId` |
| `DiscardedRetryAudits` | 未入库条目人工重试审计 | `auditId` |

### 3.2 普通字段与 JSON 字段

- `Articles`、`Events` 等主表 Sheet 保留数据库中的普通字段，不用展示层 DTO 替代数据库字段。
- `eventSubjects`、`keyPoints`、`aiSnapshot`、`manualOverrides`、`scorePolicySnapshot`、`detail` 等 JSON 字段保留原始 JSON 字符串。
- 对常用 JSON 字段可增加可读列，例如主体文本、关键点文本；可读列不能替代原始 JSON。
- 状态字段保留原始枚举值，并增加中文说明列，便于程序处理和人工阅读。
- 日期字段保留可识别的 Excel 日期值，并在 `ExportMeta` 记录 `Asia/Shanghai` 和 ISO 时间信息。
- `Jobs`、`Keywords`、`KeywordCandidates`、`TuningSuggestions` 等系统级 Sheet 按快照导出；`Events`、日志、推送、互动和关键词关系等关联 Sheet 按筛选后的 Article/Event/DiscardedItem 关联范围导出。

## 4. 原文和长文本

`ArticleContent` 使用以下结构保存完整内容：

| 字段 | 说明 |
| --- | --- |
| `articleId` | Article ID |
| `contentType` | `rawContent`、`cleanContent` 或 `articleBody` |
| `chunkNo` | 从 1 开始的分片序号 |
| `chunkTotal` | 当前内容的总分片数 |
| `contentChunk` | 当前分片文本 |

每个分片控制在 Excel 单元格限制以内，按 `articleId + contentType + chunkNo` 顺序拼接即可还原原文；其他长字段按 `sheetName + rowKey + field + chunkNo` 拼接。内容不得静默截断。

## 5. 数据安全

以下内容禁止进入工作簿：

- `Setting` 表的真实配置值
- API Key、Webhook URL、Cookie、Authorization、密码、签名和密钥
- `PushTarget.secretRef`
- `PushLog.webhookUrl`
- `Source.parserConfig` 中可能出现的认证 Header 或密钥

`PushTargets` 只导出名称、URL Hash、启用状态和时间字段。来源配置中的敏感键需要递归脱敏；错误信息也要避免原样泄露密钥。

所有文本字段必须按纯文本写入，尤其处理以 `=`, `+`, `-`, `@` 开头的标题、URL、正文和错误信息，防止 Excel 公式注入。

现有设置备份接口允许导出明文配置，仅用于系统备份；文章数据导出不得复用该接口。

## 6. 导出任务

### 6.1 独立模型

新增 `ExportJob`，不复用抓取流水线的 `Job`。建议包含：

- `id`、`status`、`filterSnapshot`、`snapshotAt`
- `progressTotal`、`progressDone`、`progressErrors`
- 当前 Sheet 或处理项说明
- 文件名、存储键、文件大小
- `error`、`createdAt`、`startedAt`、`completedAt`
- `expiresAt`、`cancelRequestedAt`、`updatedAt`
- `attempt`、`workerToken`（防止过期 Worker 覆盖新领取状态）

状态至少包括：`queued`、`running`、`succeeded`、`failed`、`cancelled`、`expired`。

### 6.2 执行规则

- 同一时间只运行一个导出任务，其余任务排队。
- 任务创建时保存完整筛选条件和 `snapshotAt`，并立即用 SQLite `VACUUM INTO` 固化只读副本，排队任务不会因等待时间丢失创建时数据边界。
- 采用分批读取和 Keyset 分页，避免单次查询加载全部文章。
- 工作簿查询全部针对已固化副本；任务进度和取消请求继续写入线上库，不持有会阻塞 SQLite 写入的长事务。每次领取任务使用 worker token，旧 Worker 不能覆盖新任务状态。
- 任务可被管理员取消；取消应在当前批次完成后安全停止。
- 失败任务可以按原条件重新生成，不复用损坏文件。
- 前端通过受保护 API 轮询任务状态，不引入 Redis、消息队列或浏览器内存队列。

## 7. 一致性快照

导出使用任务创建时的 `snapshotAt` 作为数据边界，并在任务创建时固化、随后只读的 SQLite 副本中读取各 Sheet，确保文章、Event、关系和日志之间可对应。各主记录按 `createdAt <= snapshotAt` 限定；按发布时间筛选时同样不纳入快照之后才产生的发布时间。临时副本在成功、失败、取消和服务重启恢复时清理。

导出结果必须在 `ExportMeta` 记录：

- `exportJobId`
- `snapshotAt`
- 筛选条件
- 应用版本和 `exportFormatVersion`
- 导出开始/完成时间、ISO 时间值和时区
- 每个 Sheet 的行数和错误数（成功文件的错误数为 0；生成失败的任务不产生可下载文件）

数据库没有历史版本表，因此只能导出快照时已有的当前字段值，不能还原过去某次 AI 运行的完整输入输出。

## 8. 筛选条件

默认提供“全部导出”，并支持：

- 日期范围：默认按 `Article.createdAt`，可切换 `publishedAt`、`updatedAt`；`DiscardedItem` 没有 `updatedAt`，选择更新时间时必须关闭未入库条目或改用其他日期字段
- 来源
- `fetchStatus`、`aiStatus`、`clusterStatus`
- `publicStatus`、是否代表文章、是否已推送
- Event ID
- 是否包含未入库条目

日期输入固定按 `Asia/Shanghai` 解析，结束时间使用半开区间，避免边界重复；需要按自然日筛选时输入当天 `00:00` 到次日 `00:00`。

## 9. 文件存储与下载

- 文件保存于公开静态目录之外的 `db/exports`。
- 文件名使用不可预测的随机存储键，展示名可使用 `hot2-export-YYYYMMDD-HHmmss.xlsx`。
- 下载接口必须经过现有后台 Token 鉴权。
- 成功文件保留 24 小时；过期后删除文件，仅保留任务记录。
- 取消或失败任务产生的临时文件立即清理。
- 清理逻辑接入现有调度/维护机制，不清理数据库原始文章数据；文件删除失败的任务保留为不可下载的失败记录，等待下一次清理重试，避免留下无追踪文件。
- 执行“删除全部文章”或“清空全部数据”等危险维护操作时，会主动取消并删除现有导出任务/文件，避免下载已经失效的业务数据快照；这不影响数据库原始记录的清理流程。

## 10. 管理后台交互

位置：`设置 → 数据维护 → Excel 导出`。

页面提供：

1. 筛选条件配置
2. 创建导出任务
3. 最近 20 条导出任务
4. 排队、生成中、成功、失败、已取消、已过期状态
5. 进度、错误提示、取消、重试和下载按钮
6. 文件过期倒计时或过期时间

文章数据导出服务应保持独立，后续工作台文章库可以复用同一服务增加筛选导出入口。

## 11. 实现边界

- Route Handler 只负责鉴权、参数校验和响应转换。
- 导出查询、快照、脱敏、分片、工作簿生成和清理逻辑放入 `src/lib/` 服务。
- 前端只通过 `src/features/*-api.client.ts` 访问导出 API。
- 不改变公开端文章、Event 去重、公开和推送门禁规则。
- 不把 `needs_review` 重新变成代表文章、公开文章或推送文章；导出只记录其真实状态。

## 12. 文档、迁移与验收

实现时需要同步更新：

- `README.md` 的架构和管理功能说明
- Prisma Schema
- 当前 baseline migration
- 相关 API/服务注释

当前实现文件：

- `src/contracts/data-export.ts`
- `src/lib/export/export-workbook.ts`
- `src/lib/export/export-service.ts`
- `src/features/data-export-api.client.ts`
- `src/components/settings/data-export.tsx`
- `src/app/api/data-export/`

验收标准：

- 全部 `Article` 均可导出，处理失败和人工忽略记录不丢失。
- 未入库条目及其原因、重试审计可追溯。
- Article、Event、代表关系和历史聚类审计可通过 ID 关联。
- 三类正文均可从 `ArticleContent` 完整还原。
- 无敏感配置泄露，文本不会被 Excel 当作公式执行。
- 导出期间数据变更不会造成 Sheet 之间的快照混杂。
- 任务可排队、取消、失败重试、过期清理和受保护下载。
- `ExportMeta` 的行数统计可用于核对导出完整性。
