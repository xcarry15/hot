# 分类维护增强设计：新增 / 删除 / 显示隐藏

日期：2026-08-11
状态：已批准（用户确认）

## 背景与目标

后台「设置 → 工具中心」的「分类维护」当前仅支持**重命名**与**上移/下移排序**。本设计为分类维护增加三项能力：

1. **新增分类**：管理员可动态创建分类（当前分类 id 是代码层固定枚举，无法新增）
2. **删除分类**：仅允许删除空分类，清理废弃目录
3. **显示/隐藏分类**：控制分类是否出现在公开工具中心页面

**目标**：让管理员无需改代码即可维护公开工具目录的分类结构。

## 现状与关键约束

### 数据模型（prisma/schema.prisma）

```prisma
model ToolDirectoryCategory {
  id        String   @id
  name      String   @unique
  sortOrder Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([sortOrder])
  @@map("tool_directory_categories")
}
```

### 核心架构约束

分类 ID 在**代码层是写死的固定枚举**：

- `src/contracts/tool-directory.ts`：`TOOL_CATEGORY_SEED_DEFINITIONS` 定义 5 个 id（business-support / geo-location / data-analysis / network-planning / other-tools），`ToolDirectoryCategoryId` 是这 5 个 id 的联合类型
- `src/lib/tool-directory-schema.ts`：工具 schema 的 `category` 字段用 `z.enum(categoryIds)` 硬约束
- `src/lib/tool-directory-service.ts`：`categoryIdSet`（第 48 行）校验 id 是否属于种子集合

数据库层 `id` 只是普通 `String @id`，支持任意值——**约束完全在代码层**。本次改动即放开该约束。

### 种子分类入库

种子分类通过迁移 `prisma/migrations/20260809153000_add_tool_directory_categories/migration.sql` 和 `prisma/seed.ts` 写入。种子分类保持存在，`TOOL_CATEGORY_SEED_DEFINITIONS` 转为"初始种子数据"，不再充当合法 id 的封闭集合。

### 现有 API 与缓存

- `GET /api/tools/categories` → `listToolDirectoryCategories()`（管理端，返回全部）
- `PUT /api/tools/categories/[id]` → `updateToolDirectoryCategory(id, {name, sortOrder})`
- `POST /api/tools/categories/reorder` → 排序
- 公开页：`readPublicToolCategories()` 经 `unstable_cache(..., { tags: [TOOL_DIRECTORY_CACHE_TAG] })` 缓存 3600s；所有变更后须调用 `revalidateTag(TOOL_DIRECTORY_CACHE_TAG, 'max')`（已有先例，第 209 行）

## 设计

### 1. 数据模型（Prisma）

给 `ToolDirectoryCategory` 增加隐藏字段：

```prisma
model ToolDirectoryCategory {
  id        String   @id
  name      String   @unique
  sortOrder Int      @default(0)
  hidden    Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

新增迁移（`hidden` 列，默认 false）。

### 2. 类型与校验

**contracts（src/contracts/tool-directory.ts）：**

- `ToolDirectoryCategoryId`：从固定 5 个 id 联合 → `string`
- `ToolDirectoryCategoryDto`：增加 `hidden: boolean`
- `TOOL_CATEGORY_SEED_DEFINITIONS`：保留为种子数据常量，注释改为"初始分类种子，运行时分类由数据库维护"
- 新增 `TOOL_CATEGORY_ID_PATTERN` 或常量：slug 格式 `^[a-z][a-z0-9-]*$`

**schema（src/lib/tool-directory-schema.ts）：**

- 工具 `category` 字段：`z.enum(categoryIds)` → `z.string().min(1)`；存在性改由服务层 DB 查询保证
- `toolCategoryUpdateSchema`：增加可选 `hidden: z.boolean()`
- 新增 `toolCategoryCreateSchema`：`{ id, name }`
  - `id`：slug 格式正则校验 + 长度上限
  - `name`：非空、trim、长度上限（沿用现有 name 规则）

### 3. 服务层（src/lib/tool-directory-service.ts）

- **移除** `categoryIdSet` 常量；所有校验改走 `getCategoryOrThrow`（DB 查询，已存在）
- `mapStoredCategory`：增加 `hidden` 字段映射
- `listToolDirectoryCategories()`：保持返回全部（含隐藏，供管理端）
- `readPublicToolCategories()`：过滤 `hidden === true` 的分类（含其工具）——公开页自动隐藏，公开页组件零改动
- 新增 `createToolDirectoryCategory({ id, name })`：
  - 校验 slug 格式（复用 schema）
  - 查重：`id` 与 `name` 唯一（DB `@unique` 捕获 + 预查给出明确中文错误）
  - `sortOrder = max+1` 插入
  - `revalidateTag(TOOL_DIRECTORY_CACHE_TAG, 'max')`
- 新增 `deleteToolDirectoryCategory(id)`：
  - 校验分类存在
  - **仅当分类下无任何工具（含已归档 `archivedAt != null`）** 才允许删除，否则抛 `ToolDirectoryValidationError('分类下仍有工具，请先迁移或删除后再删除分类')`
  - 删除后 `revalidateTag(TOOL_DIRECTORY_CACHE_TAG, 'max')`
- 隐藏开关复用 `updateToolDirectoryCategory`（update schema 支持 `hidden`）；变更后 `revalidateTag`
- `ToolCategoryUpdateInput` / `ToolCategoryCreateInput` 类型相应扩展

### 4. API 层

- **src/app/api/tools/categories/route.ts**：新增 `POST` handler
  - 校验 `toolCategoryCreateSchema`，调用 `createToolDirectoryCategory`，`runExclusiveMutation('新增工具分类', ...)` 包裹（沿用现有模式）
- **src/app/api/tools/categories/[id]/route.ts**：新增 `DELETE` handler
  - 调用 `deleteToolDirectoryCategory(id)`，`runExclusiveMutation('删除工具分类', ...)` 包裹
  - `PUT` 保持，支持 `hidden`
- 错误响应沿用 `apiError` + `formatToolSchemaError`

### 5. 管理端 UI（src/components/settings/tool-directory.tsx 分类维护弹窗）

- 弹窗顶部「新增分类」：名称 + 英文 slug 两个输入框 + 提交按钮；slug 输入带格式提示（小写字母/数字/连字符）
- 每行分类操作区新增：
  - **隐藏开关**（shadcn `Switch` 组件切换 `hidden`），调 `PUT [id]` `{ hidden }`
  - **删除按钮**：分类下有工具时禁用，`title` 提示「请先迁移或删除分类内工具」；空分类可删，删除走确认弹窗
- 已隐藏分类：行背景弱化 + 角标「已隐藏」，仍可编辑名称/排序/取消隐藏
- 新增/删除/隐藏后 `loadTools()` 刷新列表

### 6. 公开页

无改动。服务层 `readPublicToolCategories` 已过滤隐藏分类。

## 边界情况

- 删除非空分类（含仅有已归档工具）→ 阻止，返回明确中文错误
- 隐藏的分类不丢失工具，管理端可随时取消隐藏
- slug 与 name 唯一冲突 → 服务层返回明确中文错误，前端 toast / 内联提示
- slug 格式非法 → schema 校验错误，前端内联提示
- 新建分类默认 `sortOrder = max+1`，出现在最后；可用现有上移/下移调整
- 缓存失效：新增/删除/隐藏/重命名/排序后均 `revalidateTag`，保证公开页 1 小时内同步（与现有行为一致）

## 验证

- 后端：`npm run test`（现有测试通过），新增针对分类创建/删除/隐藏的服务层单测（若现有测试体系覆盖 tool-directory）
- 前端：`npx tsc --noEmit`、`npx eslint`
- 手动验证路径：
  1. 新增分类 → 公开页出现且排序正确
  2. 隐藏分类 → 公开页消失、管理端弱化显示、工具保留
  3. 取消隐藏 → 公开页恢复
  4. 删除空分类 → 成功
  5. 删除非空分类 → 阻止并提示
  6. 重复 slug / 重复 name → 明确报错

## 不做的事（YAGNI）

- 不新增分类简介、图标（未选）
- 不做批量移动工具（未选）
- 不做拖拽排序（未选）
- 不做分类归档软删除（删除仅限空分类）
