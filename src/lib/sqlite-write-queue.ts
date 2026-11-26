import type { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * SQLite 写事务串行化 + 瞬态冲突重试。
 *
 * 背景（2026-11-20 审查 P0-1）：SQLite 是单写者，项目却按「多连接可并发写事务」
 * 使用。开发机实测并发 8 个交互式事务时默认配置仅 1 个成功、7 个抛
 * P1008 / P2028；线上 error.log 的 862 次 Socket timeout / 239 次 P1008 /
 * 205 次 Transaction already closed 与之同型。
 *
 * 为什么不改成 connection_limit=1：实测单连接下，交互式事务体内通过全局 db
 * 发起的查询会等待自己持有的连接而自锁（P2028）。项目多处事务内调用
 * assertWorkerCanWrite / refreshPublicPublication 等会查库的 helper，
 * 因此保留多连接，改为在 db 实例上串行化「回调式交互式事务」。
 *
 * 连接级 PRAGMA（P0-2）：实测 Prisma 默认已把 busy_timeout=5000 与
 * foreign_keys=ON 应用到池中每条连接；synchronous 除初始化连接外为 FULL(2)，
 * 比 NORMAL(1) 更安全；foreign_keys 在事务内设置是 no-op。这里在每个事务
 * 绑定的连接上重新声明 busy_timeout，使配置不再依赖「初始化那一条连接」。
 *
 * 只拦截回调式 $transaction(fn, options)：数组式 $transaction([...]) 是多个
 * 独立语句的顺序执行，不参与队列（保持原有吞吐）。
 */
const TRANSIENT_CODES = new Set(['P1008', 'P2028', 'P2024', 'P2034']);
const TRANSIENT_MESSAGE = /(database is locked|database table is locked|SQLITE_BUSY|Transaction already closed|Socket timeout|timed out)/i;

export function isTransientSqliteError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_MESSAGE.test(message);
}

export interface WriteQueueStats {
  serialized: number;
  retries: number;
  exhausted: number;
}

const stats: WriteQueueStats = { serialized: 0, retries: 0, exhausted: 0 };

export function getWriteQueueStats(): Readonly<WriteQueueStats> {
  return { ...stats };
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 25;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TransientRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

/**
 * 独立读写语句的瞬态错误重试。
 *
 * 写队列只串行化回调式 $transaction；线上 P1008 仍来自 `article.update()`、
 * `keywordCandidate.upsert()`、`setting.updateMany()`、`article.count()` 等
 * 未经队列的独立语句。这里提供统一的重试入口，与队列共用同一瞬态判定。
 */
export async function withTransientSqliteRetry<T>(
  operation: () => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? BASE_DELAY_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientSqliteError(error) || attempt === maxRetries) throw error;
      await delay(baseDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

type RawTransaction = (a: unknown, b?: unknown) => Promise<unknown>;
const GUARD_FLAG = Symbol.for('hot2.sqliteWriteQueue.installed');

/**
 * 嵌套事务透传：若某个事务回调内部又调用了 db.$transaction，内层若再入队
 * 就会等待外层完成 → 永久死锁。用 ALS 标记「当前已在队列事务上下文内」，
 * 内层直接走原始实现（Prisma 会为它分配另一条连接），不入队。
 */
const inQueuedTransaction = new AsyncLocalStorage<boolean>();

export function isInsideQueuedTransaction(): boolean {
  return inQueuedTransaction.getStore() === true;
}

/**
 * create / createMany 若「写入成功但响应超时」后重试会产生重复记录，
 * $executeRaw 的幂等性由调用方保证，统一不重试。
 * 队列事务内部的语句由外层队列负责重试，此处不再叠加。
 */
const NON_RETRYABLE_PRISMA_ACTIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  // delete 重试时若首次已提交，第二次会抛 P2025，把成功的操作误报为失败。
  'delete',
  // raw 查询不经 $allModels 扩展，保留在此只为显式声明意图。
  '$executeRaw',
  '$executeRawUnsafe',
]);

function containsAtomicIncrement(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if ('increment' in value || 'decrement' in value || 'multiply' in value) return true;
  return Object.values(value as Record<string, unknown>).some(containsAtomicIncrement);
}

const NESTED_WRITE_OPERATORS = new Set([
  'create',
  'createMany',
  'connectOrCreate',
  'upsert',
  'delete',
  'deleteMany',
]);

function containsUnsafeNestedWrite(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (NESTED_WRITE_OPERATORS.has(key)) return true;
    if (nested && typeof nested === 'object' && containsUnsafeNestedWrite(nested)) return true;
  }
  return false;
}

function normalizedPayload(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizedPayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, normalizedPayload((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function shouldRetryPrismaAction(action: string, args?: unknown): boolean {
  if (isInsideQueuedTransaction() || NON_RETRYABLE_PRISMA_ACTIONS.has(action)) return false;
  // 「写入成功但响应超时」后重试只有幂等写才安全：
  // 原子自增会重复计数，嵌套 create/connectOrCreate 会产生重复子记录。
  // update 的载荷在 data 下，其他操作的载荷可能在 create/update 下，一并检查。
  const payload = args && typeof args === 'object'
    ? args as { data?: unknown; update?: unknown; create?: unknown }
    : {};
  const writes = [payload.data, payload.update, payload.create];
  if (writes.some((write) => containsAtomicIncrement(write) || containsUnsafeNestedWrite(write))) {
    return false;
  }
  // upsert 首次写入后超时，重试会命中 update 分支。只有 create/update
  // 写值完全等价时结果才一致（例如离线统计回填），否则禁止重试以避免静默改值。
  if (action === 'upsert') {
    return JSON.stringify(normalizedPayload(payload.create))
      === JSON.stringify(normalizedPayload(payload.update));
  }
  return true;
}

/**
 * 在 PrismaClient 实例上安装队列。幂等：Next.js HMR / 多模块 import 只生效一次。
 */
export function installSqliteWriteQueue<T extends PrismaClient>(db: T): T {
  const flagged = db as T & { [GUARD_FLAG]?: boolean };
  if (flagged[GUARD_FLAG]) return db;

  const original = db.$transaction.bind(db) as unknown as RawTransaction;
  let tail: Promise<unknown> = Promise.resolve();

  const wrapped = (first: unknown, second?: unknown): Promise<unknown> => {
    // 数组式事务、或已在队列事务上下文内的嵌套调用：透传，不入队（防自锁）。
    if (typeof first !== 'function' || isInsideQueuedTransaction()) {
      return original(first, second);
    }

    const callback = first as (tx: Prisma.TransactionClient) => Promise<unknown>;

    const execute = async (): Promise<unknown> => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          return await inQueuedTransaction.run(true, () => original(
            async (tx: Prisma.TransactionClient) => {
              await tx.$queryRawUnsafe('PRAGMA busy_timeout=5000');
              return callback(tx);
            },
            second,
          ));
        } catch (error) {
          lastError = error;
          if (!isTransientSqliteError(error) || attempt === MAX_RETRIES) {
            if (isTransientSqliteError(error)) stats.exhausted++;
            throw error;
          }
          stats.retries++;
          await delay(BASE_DELAY_MS * (attempt + 1));
        }
      }
      throw lastError;
    };

    stats.serialized++;
    const result = tail.then(execute, execute);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  // writable 必须为 true：Vitest 的 vi.spyOn / 直接赋值打桩需要可写属性，
  // 否则真实 PrismaClient 实例上的 $transaction 无法被测试替换（restore 也会失败）。
  // 幂等安装靠 GUARD_FLAG，不依赖只读属性防重复包装。
  Object.defineProperty(db, '$transaction', {
    value: wrapped,
    writable: true,
    configurable: true,
  });
  flagged[GUARD_FLAG] = true;
  return db;
}
