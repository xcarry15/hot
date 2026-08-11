# 分类维护增强实现计划（新增 / 删除 / 显示隐藏）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让后台「工具中心 → 分类维护」支持动态新增分类、删除空分类、显示/隐藏分类，且公开工具中心页面自动应用隐藏。

**Architecture:** 把分类 ID 从代码层固定枚举（`TOOL_CATEGORY_SEED_DEFINITIONS` / `categoryIdSet` / `z.enum(categoryIds)`）放宽为数据库动态字符串；给 `ToolDirectoryCategory` 增加 `hidden` 字段；公开页读取时过滤隐藏分类；新增服务层创建/删除分类函数 + API + 管理端 UI。备份快照 schema 同步放宽以兼容动态分类。

**Tech Stack:** Next.js 15（App Router）、Prisma + SQLite、zod、React、shadcn/ui（Switch、Dialog、AlertDialog、Button、Input）、vitest

## Global Constraints

- 分类英文 slug 格式：`/^[a-z][a-z0-9-]*$/`，长度 ≤ 50
- 分类名称：非空、trim、长度 ≤ 30（沿用现有 `toolCategoryUpdateSchema` 规则）
- 删除分类仅限空分类：分类下**无任何工具（含已归档 `archivedAt != null`）**才允许
- 所有分类变更后必须调用 `invalidatePublicTools()`（内部 `revalidatePath('/tools')` + `revalidateTag(TOOL_DIRECTORY_CACHE_TAG, 'max')`）
- API 层的分类变更 handler 一律用 `runExclusiveMutation('操作名', ...)` 包裹
- 备份快照中 `hidden` 为可选字段（兼容旧备份，恢复时缺省 `false`）
- 本仓库类型检查：`npx tsc --noEmit`；单测：`npx vitest run <file>`
- 中文文案，全角标点，不用斜体

---

### Task 1: 数据模型与迁移

**Files:**
- Modify: `prisma/schema.prisma`（`ToolDirectoryCategory` 模型）
- Create: `prisma/migrations/20260811090000_add_tool_category_hidden/migration.sql`

**Interfaces:**
- Produces: `ToolDirectoryCategory` 模型新增 `hidden Boolean @default(false)` 字段；迁移文件使既有数据库获得该列。

- [ ] **Step 1: 修改 Prisma schema**

在 `prisma/schema.prisma` 的 `ToolDirectoryCategory` 模型中 `sortOrder Int @default(0)` 行后新增一行：

```prisma
model ToolDirectoryCategory {
  id        String   @id
  name      String   @unique
  sortOrder Int      @default(0)
  hidden    Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([sortOrder])
  @@map("tool_directory_categories")
}
```

- [ ] **Step 2: 创建迁移文件**

创建 `prisma/migrations/20260811090000_add_tool_category_hidden/migration.sql`：

```sql
-- Add hidden flag to tool directory categories
ALTER TABLE "tool_directory_categories" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 3: 验证 schema 合法**

Run: `npx prisma validate`
Expected: exit 0，输出 `Schema is valid`（或等价确认）。

- [ ] **Step 4: 应用迁移（本地 dev 库）**

若本地 SQLite 可用：`npx prisma migrate deploy`
若无法连接数据库（如 CI/无 dev DB），跳过并在提交说明注明；测试全部 mock db，不依赖迁移。

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260811090000_add_tool_category_hidden/migration.sql
git commit -m "feat: 工具分类增加 hidden 隐藏字段与迁移"
```

---

### Task 2: contracts 类型放宽 + schema 更新（含备份快照）

**Files:**
- Modify: `src/contracts/tool-directory.ts`
- Modify: `src/lib/tool-directory-schema.ts`
- Test: `tests/tool-directory-schema.test.ts`
- Test: `tests/backup-schema.test.ts`

**Interfaces:**
- Consumes: `TOOL_CATEGORY_SEED_DEFINITIONS`（保留为种子数据）
- Produces:
  - `ToolDirectoryCategoryId = string`
  - `ToolDirectoryCategoryDto` 增加 `hidden: boolean`
  - `TOOL_CATEGORY_ID_PATTERN = /^[a-z][a-z0-9-]*$/`
  - `toolCategoryCreateSchema` → `{ id: string; name: string }`
  - `toolCategoryUpdateSchema` → `{ name?: string; hidden?: boolean }`（至少一项）
  - `toolCategoryReorderSchema.id` → `string`
  - `toolDirectorySnapshotSchema` 分类数组动态化（含可选 `hidden`）
  - `ToolCategoryCreateInput` 导出

- [ ] **Step 1: 修改 contracts 类型**

`src/contracts/tool-directory.ts`：

把 `ToolDirectoryCategoryId` 从固定联合改为 `string`：

```ts
/** 工具分类 ID 由数据库维护，运行时动态创建；保留种子仅为初始化。 */
export type ToolDirectoryCategoryId = string;

/** 新分类 slug 格式：小写字母开头，仅小写字母/数字/连字符。 */
export const TOOL_CATEGORY_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
```

更新 `TOOL_CATEGORY_SEED_DEFINITIONS` 顶部注释（改为"初始种子，运行时分类由数据库维护"），并给 `ToolDirectoryCategoryDto` 增加字段：

```ts
export interface ToolDirectoryCategoryDto {
  id: ToolDirectoryCategoryId;
  name: string;
  sortOrder: number;
  hidden: boolean;
}
```

- [ ] **Step 2: 修改 schema —— 工具分类字段动态化**

`src/lib/tool-directory-schema.ts`：

删除第 11 行 `const categoryIds = ...`。然后逐个替换 `z.enum(categoryIds ...)`：

`toolFields.category` 改为：
```ts
category: z.string().trim().min(1, '请选择分类'),
```

`toolCategoryReorderSchema` 改为：
```ts
export const toolCategoryReorderSchema = z.object({
  id: z.string().trim().min(1, '分类 ID 无效'),
  direction: z.enum(['up', 'down']),
}).strict();
```

`toolSnapshotItemSchema` 的 `category` 改为：
```ts
category: z.string().trim().min(1, '分类无效'),
```

- [ ] **Step 3: 修改 schema —— 新增/更新分类 schema**

`toolCategoryUpdateSchema` 改为（允许只改名称或只改隐藏，至少一项）：

```ts
export const toolCategoryUpdateSchema = z.object({
  name: z.string().trim().min(1, '分类名称为必填项').max(30, '分类名称不能超过 30 个字符'),
  hidden: z.boolean(),
}).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  '至少提供一个要更新的字段',
);
```

新增创建 schema（放在 `toolCategoryUpdateSchema` 之后）：

```ts
export const toolCategoryCreateSchema = z.object({
  id: z.string().trim()
    .regex(TOOL_CATEGORY_ID_PATTERN, '分类标识仅支持小写字母、数字与连字符，且以小写字母开头')
    .max(50, '分类标识不能超过 50 个字符'),
  name: z.string().trim().min(1, '分类名称为必填项').max(30, '分类名称不能超过 30 个字符'),
}).strict();
```

在文件末尾的类型导出区增加：
```ts
export type ToolCategoryCreateInput = z.infer<typeof toolCategoryCreateSchema>;
```

- [ ] **Step 4: 修改 schema —— 备份快照动态化**

`toolDirectorySnapshotSchema` 的 categories 数组改为动态（去掉 `.length(categoryIds.length)` 与 id 在种子集检查，改为 slug 格式校验 + 工具引用分类校验）：

```ts
export const toolDirectorySnapshotSchema = z.object({
  categories: z.array(z.object({
    id: z.string().trim().min(1, '分类 ID 无效').max(50, '分类 ID 无效'),
    name: z.string().trim().min(1, '分类名称为必填项').max(30, '分类名称不能超过 30 个字符'),
    sortOrder: z.number().int('分类排序无效').min(0, '分类排序无效').max(100, '分类排序无效'),
    hidden: z.boolean().optional(),
  }).strict()).min(1, '至少需要一个分类').max(50, '分类数量超过上限'),
  tools: z.array(toolSnapshotItemSchema).max(1_000, '工具数量超过上限'),
}).strict().superRefine((value, context) => {
  const categoryIdsInBackup = value.categories.map((category) => category.id);
  if (new Set(categoryIdsInBackup).size !== categoryIdsInBackup.length) {
    context.addIssue({ code: 'custom', path: ['categories'], message: '分类 ID 不能重复' });
  }
  if (categoryIdsInBackup.some((id) => !TOOL_CATEGORY_ID_PATTERN.test(id))) {
    context.addIssue({ code: 'custom', path: ['categories'], message: '分类 ID 仅支持小写字母、数字与连字符' });
  }
  const categoryNames = value.categories.map((category) => category.name.toLocaleLowerCase());
  if (new Set(categoryNames).size !== categoryNames.length) {
    context.addIssue({ code: 'custom', path: ['categories'], message: '分类名称不能重复' });
  }
  const sortOrders = value.categories.map((category) => category.sortOrder);
  if (new Set(sortOrders).size !== sortOrders.length) {
    context.addIssue({ code: 'custom', path: ['categories'], message: '分类排序不能重复' });
  }
  const toolIds = value.tools.map((tool) => tool.id);
  if (new Set(toolIds).size !== toolIds.length) {
    context.addIssue({ code: 'custom', path: ['tools'], message: '工具 ID 不能重复' });
  }
  for (const [index, tool] of value.tools.entries()) {
    if (!categoryIdsInBackup.includes(tool.category)) {
      context.addIssue({ code: 'custom', path: ['tools', index, 'category'], message: '工具引用了不存在的分类' });
    }
    const parsed = toolCreateSchema.safeParse({
      name: tool.name,
      description: tool.description,
      category: tool.category,
      href: tool.href,
      icon: tool.icon,
      status: tool.status,
      tags: tool.tags,
    });
    if (!parsed.success) {
      context.addIssue({
        code: 'custom',
        path: ['tools', index],
        message: parsed.error.issues[0]?.message || '工具配置无效',
      });
    }
  }
});
```

`src/lib/tool-directory-schema.ts` 顶部需要 import `TOOL_CATEGORY_ID_PATTERN`（加入现有 `@/contracts/tool-directory` 的 import 中）。

- [ ] **Step 5: 运行现有测试确认仍通过（或记录预期破坏点）**

Run: `npx vitest run tests/tool-directory-schema.test.ts tests/backup-schema.test.ts -u`
Expected: 测试通过；若有断言依赖旧的固定 5 分类 / `.length()` 行为，更新对应断言为新 schema 语义（动态分类、`hidden` 可选）。

- [ ] **Step 6: Commit**

```bash
git add src/contracts/tool-directory.ts src/lib/tool-directory-schema.ts tests/tool-directory-schema.test.ts tests/backup-schema.test.ts
git commit -m "feat: 工具分类 ID 动态化，schema 支持新增/隐藏与动态备份快照"
```

---

### Task 3: 服务层（隐藏过滤 + 新增/删除分类）

**Files:**
- Modify: `src/lib/tool-directory-service.ts`
- Test: `tests/tool-directory-service.test.ts`

**Interfaces:**
- Consumes: `ToolCategoryCreateInput`、`ToolCategoryUpdateInput`、`toolCategoryCreateSchema`、`TOOL_CATEGORY_ID_PATTERN`（来自 Task 2）
- Produces:
  - `createToolDirectoryCategory(input: ToolCategoryCreateInput): Promise<ToolDirectoryCategoryDto>`
  - `deleteToolDirectoryCategory(id: string): Promise<ToolDirectoryCategoryDto>`
  - `updateToolDirectoryCategory(id: string, input: ToolCategoryUpdateInput)` 支持 `hidden`
  - `readPublicToolCategories()` 过滤 `hidden === true`

- [ ] **Step 1: 移除固定枚举并映射 hidden**

`src/lib/tool-directory-service.ts`：

删除第 48 行 `const categoryIdSet = new Set(...)`（及其对 `TOOL_CATEGORY_SEED_DEFINITIONS` 的 import，若不再使用）。

`mapStoredCategory` 增加 hidden 映射：
```ts
function mapStoredCategory(category: NonNullable<StoredCategory>): ToolDirectoryCategoryDto {
  return {
    id: category.id,
    name: category.name,
    sortOrder: category.sortOrder,
    hidden: category.hidden,
  };
}
```

- [ ] **Step 2: 公开页过滤隐藏分类**

`readPublicToolCategories()` 中，在 `categories.map(...)` 前过滤：
```ts
const visibleCategories = categories.filter((category) => !category.hidden);
return visibleCategories.map((category) => ({
  id: category.id,
  label: category.name,
  tools: sortedTools
    .filter((tool) => tool.category === category.id)
    .map(toPublicTool),
}));
```

- [ ] **Step 3: 新增 createToolDirectoryCategory**

放在 `updateToolDirectoryCategory` 之前：

```ts
export async function createToolDirectoryCategory(input: ToolCategoryCreateInput): Promise<ToolDirectoryCategoryDto> {
  const parsed = toolCategoryCreateSchema.safeParse(input);
  if (!parsed.success) throw new ToolDirectoryValidationError(parsed.error.issues[0]?.message || '分类参数无效');
  const { id, name } = parsed.data;

  const [idTaken, nameTaken] = await Promise.all([
    db.toolDirectoryCategory.findUnique({ where: { id } }),
    db.toolDirectoryCategory.findUnique({ where: { name } }),
  ]);
  if (idTaken) throw new ToolDirectoryValidationError('分类标识已存在');
  if (nameTaken) throw new ToolDirectoryValidationError('分类名称已存在');

  const max = await db.toolDirectoryCategory.aggregate({ _max: { sortOrder: true } });
  const category = await db.toolDirectoryCategory.create({
    data: { id, name, sortOrder: (max._max.sortOrder ?? -1) + 1 },
  });
  invalidatePublicTools();
  return mapStoredCategory(category);
}
```

需要 import `toolCategoryCreateSchema` 到本文件（加入现有 `@/lib/tool-directory-schema` import）。

- [ ] **Step 4: 新增 deleteToolDirectoryCategory**

放在 `createToolDirectoryCategory` 之后：

```ts
export async function deleteToolDirectoryCategory(id: string): Promise<ToolDirectoryCategoryDto> {
  const category = await getCategoryOrThrow(id);
  const hasTools = await db.toolDirectoryItem.findFirst({
    where: { category: id },
    select: { id: true },
  });
  if (hasTools) throw new ToolDirectoryValidationError('分类下仍有工具，请先迁移或删除后再删除分类');
  await db.toolDirectoryCategory.delete({ where: { id } });
  invalidatePublicTools();
  return mapStoredCategory(category);
}
```

- [ ] **Step 5: 更新 updateToolDirectoryCategory 支持 hidden**

```ts
export async function updateToolDirectoryCategory(
  id: string,
  input: ToolCategoryUpdateInput,
): Promise<ToolDirectoryCategoryDto> {
  await getCategoryOrThrow(id);
  const data: { name?: string; hidden?: boolean } = {};
  if (input.name !== undefined) {
    const duplicate = await db.toolDirectoryCategory.findUnique({ where: { name: input.name } });
    if (duplicate && duplicate.id !== id) throw new ToolDirectoryValidationError('分类名称已存在');
    data.name = input.name;
  }
  if (input.hidden !== undefined) data.hidden = input.hidden;
  const category = await db.toolDirectoryCategory.update({ where: { id }, data });
  invalidatePublicTools();
  return mapStoredCategory(category);
}
```

同时把参数类型 `ToolDirectoryCategoryId` → `string`（函数签名处的 cast 一并去除）。

- [ ] **Step 6: 快照恢复写 hidden**

`replaceToolDirectorySnapshotInTransaction` 的 `createMany` data 增加：
```ts
data: snapshot.categories.map((category) => ({
  id: category.id,
  name: category.name,
  sortOrder: category.sortOrder,
  hidden: category.hidden ?? false,
})),
```

- [ ] **Step 7: 更新并新增服务测试**

`tests/tool-directory-service.test.ts`：

`storedCategory` fixture 增加 `hidden: false`。`mocks` 的 `toolDirectoryCategory` 增加 `create` / `delete` / `aggregate` / `findUnique`。

新增测试用例（沿用现有 mock 风格）：

```ts
it('公开页过滤隐藏分类', async () => {
  mocks.toolDirectoryCategory.findMany.mockResolvedValue([
    storedCategory('geo-location', 0, '位置工具'),
    { ...storedCategory('business-support', 1, '业务工具'), hidden: true },
  ]);
  mocks.toolDirectoryItem.findMany.mockResolvedValue([]);
  const categories = await getPublicToolCategories();
  expect(categories.map((c) => c.id)).toEqual(['geo-location']);
});
```

```ts
it('创建分类校验 slug 格式与查重', async () => {
  mocks.toolDirectoryCategory.findUnique.mockResolvedValueOnce(null);
  mocks.toolDirectoryCategory.findUnique.mockResolvedValueOnce(null);
  mocks.toolDirectoryCategory.aggregate.mockResolvedValue({ _max: { sortOrder: 4 } });
  mocks.toolDirectoryCategory.create.mockResolvedValue({ ...storedCategory('store-opening', 5, '新分类'), hidden: false });
  const category = await createToolDirectoryCategory({ id: 'store-opening', name: '新分类' });
  expect(category.id).toBe('store-opening');
  await expect(createToolDirectoryCategory({ id: 'Bad_ID', name: 'x' })).rejects.toThrow('分类标识仅支持小写字母');
});
```

```ts
it('删除空分类成功，删除非空分类被拒', async () => {
  mocks.toolDirectoryCategory.findUnique.mockResolvedValue(storedCategory('other-tools', 4, '其他工具'));
  mocks.toolDirectoryItem.findFirst.mockResolvedValue(null);
  mocks.toolDirectoryCategory.delete.mockResolvedValue(storedCategory('other-tools', 4, '其他工具'));
  await expect(deleteToolDirectoryCategory('other-tools')).resolves.toBeTruthy();

  mocks.toolDirectoryItem.findFirst.mockResolvedValue({ id: 'tool-1' });
  await expect(deleteToolDirectoryCategory('other-tools')).rejects.toThrow('分类下仍有工具');
});
```

Run: `npx vitest run tests/tool-directory-service.test.ts`
Expected: PASS。

- [ ] **Step 8: 类型检查 + Commit**

Run: `npx tsc --noEmit`
Expected: exit 0。

```bash
git add src/lib/tool-directory-service.ts tests/tool-directory-service.test.ts
git commit -m "feat: 工具分类服务层支持创建/删除与隐藏过滤"
```

---

### Task 4: API 路由 + 客户端

**Files:**
- Modify: `src/app/api/tools/categories/route.ts`（新增 POST）
- Modify: `src/app/api/tools/categories/[id]/route.ts`（新增 DELETE）
- Modify: `src/features/tool-directory-api.client.ts`
- Test: `tests/tool-directory-api.test.ts`

**Interfaces:**
- Consumes: `createToolDirectoryCategory`、`deleteToolDirectoryCategory`、`toolCategoryCreateSchema`、`toolCategoryUpdateSchema`
- Produces: 客户端函数 `createToolDirectoryCategory(input)`、`deleteToolDirectoryCategory(id)`、`updateToolDirectoryCategory(id, {name?, hidden?})`

- [ ] **Step 1: categories/route.ts 增加 POST**

在 `GET` 之后新增：

```ts
export async function POST(request: Request) {
  try {
    const parsed = toolCategoryCreateSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: formatToolSchemaError(parsed.error) }, { status: 400 });
    }
    const category = await runExclusiveMutation('新增工具分类', () => (
      createToolDirectoryCategory(parsed.data)
    ));
    return NextResponse.json(category, { status: 201 });
  } catch (error: unknown) {
    return apiError(error, '新增工具分类失败');
  }
}
```

更新 import：加入 `toolCategoryCreateSchema`、`createToolDirectoryCategory`、`runExclusiveMutation`。

- [ ] **Step 2: categories/[id]/route.ts 增加 DELETE**

在 `PUT` 之后新增：

```ts
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const category = await runExclusiveMutation('删除工具分类', () => deleteToolDirectoryCategory(id));
    return NextResponse.json(category);
  } catch (error: unknown) {
    return apiError(error, '删除工具分类失败');
  }
}
```

更新 import：加入 `deleteToolDirectoryCategory`；`PUT` 中 `id as ToolDirectoryCategoryId` 的 cast 因类型改为 string 可去除（若保留也合法）。

- [ ] **Step 3: 客户端函数扩展**

`src/features/tool-directory-api.client.ts`：

把 `updateToolDirectoryCategory` 改为接受可选 body：

```ts
export async function updateToolDirectoryCategory(
  id: string,
  input: { name?: string; hidden?: boolean },
  signal?: AbortSignal,
): Promise<ToolDirectoryCategoryDto> {
  return requestJson<ToolDirectoryCategoryDto>('PUT', `/api/tools/categories/${id}`, { body: input, signal });
}

export async function createToolDirectoryCategory(
  input: { id: string; name: string },
  signal?: AbortSignal,
): Promise<ToolDirectoryCategoryDto> {
  return requestJson<ToolDirectoryCategoryDto>('POST', '/api/tools/categories', { body: input, signal });
}

export async function deleteToolDirectoryCategory(id: string, signal?: AbortSignal): Promise<ToolDirectoryCategoryDto> {
  return requestJson<ToolDirectoryCategoryDto>('DELETE', `/api/tools/categories/${id}`, { signal });
}
```

- [ ] **Step 4: API 路由测试**

`tests/tool-directory-api.test.ts` 增加 POST/DELETE 用例（沿用该文件现有 mock `db` 与 `runExclusiveMutation` 方式），覆盖：POST 校验通过返回 201、POST slug 非法返回 400、DELETE 空分类返回成功、DELETE 非空分类返回 409/错误。

Run: `npx vitest run tests/tool-directory-api.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查 + Commit**

Run: `npx tsc --noEmit` → exit 0。

```bash
git add "src/app/api/tools/categories/route.ts" "src/app/api/tools/categories/[id]/route.ts" src/features/tool-directory-api.client.ts tests/tool-directory-api.test.ts
git commit -m "feat: 工具分类新增/删除 API 路由与客户端"
```

---

### Task 5: 管理端 UI（分类维护弹窗）

**Files:**
- Modify: `src/components/settings/tool-directory.tsx`
- Test: `tests/tool-directory-management.test.tsx`

**Interfaces:**
- Consumes: 客户端 `createToolDirectoryCategory`、`deleteToolDirectoryCategory`、`updateToolDirectoryCategory`、`fetchToolDirectoryCategories`；UI 组件 `Switch`
- Produces: 分类维护弹窗支持新增表单、每行隐藏开关、删除按钮（非空禁用）+ 删除确认、已隐藏角标

- [ ] **Step 1: 增加状态与 handler**

`tool-directory.tsx` 组件内新增 state 与函数（放在 `handleCategoryMove` 附近）：

```tsx
const [categoryCreateOpen, setCategoryCreateOpen] = useState(false);
const [categoryForm, setCategoryForm] = useState({ id: '', name: '' });
const [categoryBusyKey, setCategoryBusyKey] = useState<string | null>(null);
const [categoryDeleteTarget, setCategoryDeleteTarget] = useState<ToolDirectoryCategoryDto | null>(null);
const [categorySaving, setCategorySaving] = useState(false);

const handleCategoryCreate = async () => {
  if (!categoryForm.id.trim() || !categoryForm.name.trim()) {
    toast.error('请填写分类标识和名称');
    return;
  }
  setCategorySaving(true);
  try {
    await createToolDirectoryCategory({ id: categoryForm.id.trim(), name: categoryForm.name.trim() });
    toast.success('分类已创建');
    setCategoryCreateOpen(false);
    setCategoryForm({ id: '', name: '' });
    await loadTools();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '创建分类失败');
  } finally {
    setCategorySaving(false);
  }
};

const handleCategoryDelete = async () => {
  if (!categoryDeleteTarget) return;
  setCategoryBusyKey(`delete:${categoryDeleteTarget.id}`);
  try {
    await deleteToolDirectoryCategory(categoryDeleteTarget.id);
    toast.success('分类已删除');
    setCategoryDeleteTarget(null);
    await loadTools();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '删除分类失败');
  } finally {
    setCategoryBusyKey(null);
  }
};

const handleCategoryToggleHidden = async (category: ToolDirectoryCategoryDto) => {
  setCategoryBusyKey(`hidden:${category.id}`);
  try {
    await updateToolDirectoryCategory(category.id, { hidden: !category.hidden });
    toast.success(category.hidden ? '分类已显示' : '分类已隐藏');
    await loadTools();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '更新分类失败');
  } finally {
    setCategoryBusyKey(null);
  }
};
```

Import 增加：`createToolDirectoryCategory`、`deleteToolDirectoryCategory`（从 `@/features/tool-directory-api.client`）、`Switch`（从 `@/components/ui/switch`）。

- [ ] **Step 2: 修改分类维护弹窗**

把「分类维护」Dialog 的标题行改为可新增，并给每行增加隐藏开关与删除按钮：

- 弹窗 header 操作区增加「新增分类」按钮（`openCategoryManagement` 下方）：
```tsx
<Button type="button" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setCategoryCreateOpen(true)}>
  <Plus className="h-3.5 w-3.5" />
  新增分类
</Button>
```
（`Plus` 已在文件顶部 lucide import 中。）

- 每行分类（`categories.map` 内）在右侧操作区追加：
```tsx
<Switch
  checked={!category.hidden}
  onCheckedChange={() => void handleCategoryToggleHidden(category)}
  disabled={categoryBusyKey !== null}
  aria-label={`${category.name} 显示状态`}
/>
<Button
  type="button"
  size="sm"
  variant="ghost"
  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
  disabled={categoryBusyKey !== null}
  title="删除分类"
  onClick={() => setCategoryDeleteTarget(category)}
>
  <Archive className="h-3.5 w-3.5" />
</Button>
```
同时分类名行前加已隐藏角标：`{category.hidden && <Badge variant="outline" className="rounded-none px-1.5 text-[10px] text-muted-foreground">已隐藏</Badge>}`（若项目用 `Badge`，否则用 `span`）。

- [ ] **Step 3: 新增分类 Dialog + 删除确认 AlertDialog**

在「分类维护」Dialog 之后新增创建 Dialog：

```tsx
<Dialog open={categoryCreateOpen} onOpenChange={setCategoryCreateOpen}>
  <DialogContent className="rounded-none sm:max-w-md [&_[data-slot=dialog-close]]:rounded-none">
    <DialogHeader>
      <DialogTitle className="text-base">新增分类</DialogTitle>
      <DialogDescription className="text-xs">英文标识用于排序与引用，创建后不可修改。</DialogDescription>
    </DialogHeader>
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label className="text-xs">英文标识（slug）*</Label>
        <Input
          value={categoryForm.id}
          onChange={(event) => setCategoryForm((current) => ({ ...current, id: event.target.value }))}
          className="h-8 rounded-none text-xs"
          placeholder="如 store-opening"
        />
        <p className="text-[10px] text-muted-foreground">仅小写字母、数字与连字符，以小写字母开头。</p>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">分类名称 *</Label>
        <Input
          value={categoryForm.name}
          onChange={(event) => setCategoryForm((current) => ({ ...current, name: event.target.value }))}
          className="h-8 rounded-none text-xs"
          placeholder="如 开店选址"
        />
      </div>
    </div>
    <DialogFooter>
      <Button type="button" variant="outline" size="sm" className="rounded-none" onClick={() => setCategoryCreateOpen(false)}>取消</Button>
      <Button type="button" size="sm" className="rounded-none" disabled={categorySaving} onClick={() => void handleCategoryCreate()}>
        {categorySaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
        创建分类
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

在现有 `archiveTarget` AlertDialog 之前新增删除确认 AlertDialog：

```tsx
<AlertDialog open={categoryDeleteTarget !== null} onOpenChange={(open) => { if (!open) setCategoryDeleteTarget(null); }}>
  <AlertDialogContent className="rounded-none">
    <AlertDialogHeader>
      <AlertDialogTitle className="text-base">确认删除分类</AlertDialogTitle>
      <AlertDialogDescription className="text-sm">
        仅空分类可删除；分类下有工具时会被阻止。
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel className="rounded-none text-xs">取消</AlertDialogCancel>
      <AlertDialogAction className="rounded-none bg-destructive text-xs hover:bg-destructive/90" onClick={() => void handleCategoryDelete()}>
        {categoryBusyKey?.startsWith('delete:') ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
        确认删除
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

- [ ] **Step 4: 组件测试**

`tests/tool-directory-management.test.tsx` 增加用例（沿用该文件现有 render/mock 风格）：渲染分类维护弹窗后——新增表单提交调用 `createToolDirectoryCategory`；点击隐藏开关调用 `updateToolDirectoryCategory(..., { hidden })`；空分类可点删除并弹确认；非空分类删除按钮禁用。

Run: `npx vitest run tests/tool-directory-management.test.tsx`
Expected: PASS。

- [ ] **Step 5: 类型检查 + ESLint + Commit**

Run: `npx tsc --noEmit` → exit 0；`npx eslint src/components/settings/tool-directory.tsx` → exit 0。

```bash
git add src/components/settings/tool-directory.tsx tests/tool-directory-management.test.tsx
git commit -m "feat: 工具分类维护支持新增、删除与显示隐藏"
```

---

### Task 6: 全量验证与收尾

**Files:**
- 无代码改动（若发现回归则修复）

**Interfaces:**
- Consumes: 全部 Task 1-5 产物

- [ ] **Step 1: 全量测试**

Run: `npx vitest run --exclude tests/migrations.test.ts`
Expected: 全部 PASS（含 backup-schema / backup-restore-transaction / tool-directory 全系列）。

- [ ] **Step 2: 类型检查 + Lint**

Run: `npx tsc --noEmit` → exit 0
Run: `npx eslint src/lib/tool-directory-schema.ts src/lib/tool-directory-service.ts "src/app/api/tools/categories/**" src/features/tool-directory-api.client.ts src/components/settings/tool-directory.tsx` → exit 0

- [ ] **Step 3: 构建**

Run: `npm run build`
Expected: 成功产出 `.next`。

- [ ] **Step 4: 手动验证清单（需浏览器，交付时向用户提供）**

1. 新增分类（slug + 名称）→ 公开工具中心出现且排序正确
2. 隐藏分类 → 公开页消失、管理端显示「已隐藏」角标、工具保留
3. 取消隐藏 → 公开页恢复
4. 删除空分类 → 成功
5. 删除非空分类 → 被阻止并提示「分类下仍有工具」
6. 重复 slug / 重复名称 → 明确中文报错
7. 导出完整备份 → 含 `hidden`；恢复旧备份（无 `hidden`）→ 默认 `false` 正常恢复

- [ ] **Step 5: 更新设计文档状态 + Commit（若有无提交的收尾改动）**

```bash
git add -A
git commit -m "chore: 分类维护功能全量验证通过" || echo "无待提交改动"
```

---

## Self-Review 记录

- **Spec 覆盖**：新增（Task 2/3/4/5 的创建 schema/服务/API/UI）、删除（Task 3 空分类校验 + Task 5 禁用与确认）、隐藏（Task 1 hidden 字段 + Task 3 公开过滤 + Task 5 开关）、备份兼容（Task 2 快照 schema + Task 3 恢复 hidden 默认）——全部有对应任务。
- **类型一致性**：`ToolDirectoryCategoryId = string` 贯穿 contracts/schema/service/route/client；`toolCategoryCreateSchema`/`updateToolDirectoryCategory`/`createToolDirectoryCategory` 签名在相邻任务中保持一致；`mapStoredCategory` 返回类型含 `hidden`。
- **边界确认**：删除仅空分类（含已归档）由 `findFirst where category` 保证；旧备份无 `hidden` 时 `?? false` 兜底。
