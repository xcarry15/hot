import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient, type ExportJob, type ExportJobStatus } from '@prisma/client';
import { exportFilterSchema, type ExportFilter, type ExportJobDto, type ExportJobStatusValue } from '@/contracts/data-export';
import { db } from '@/lib/db';
import { buildExportWorkbook, type ExportProgress } from './export-workbook';

const EXPORT_RETENTION_MS = 24 * 60 * 60 * 1000;
const EXPORT_STALE_MS = 30 * 60 * 1000;
const EXPORT_STORAGE_DIR = path.resolve(process.cwd(), 'db', 'exports');

let exportWorkerPromise: Promise<void> | null = null;
let exportMaintenanceInProgress = false;
let exportMaintenancePromise: Promise<number> | null = null;

export class ExportInputError extends Error {
  readonly exposeToClient = true;
  readonly status = 400;
}

export class ExportJobNotFoundError extends Error {
  readonly exposeToClient = true;
  readonly status = 404;
}

export class ExportJobConflictError extends Error {
  readonly exposeToClient = true;
  readonly status = 409;
}

class ExportCancelledError extends Error {}

function normalizeFilter(input: unknown): ExportFilter {
  const parsed = exportFilterSchema.safeParse(input ?? {});
  if (!parsed.success) throw new ExportInputError('导出筛选条件无效');
  if (parsed.data.includeDiscarded && parsed.data.dateField === 'updatedAt') {
    throw new ExportInputError('未入库条目不支持按更新时间筛选，请改用创建时间或发布时间');
  }
  const from = parseShanghaiDate(parsed.data.from, '开始时间');
  const to = parseShanghaiDate(parsed.data.to, '结束时间');
  if (from && to && from.getTime() >= to.getTime()) {
    throw new ExportInputError('开始时间必须早于结束时间');
  }
  return {
    ...parsed.data,
    from: from?.toISOString() ?? '',
    to: to?.toISOString() ?? '',
  };
}

function parseShanghaiDate(value: string, label: string): Date | undefined {
  if (!value) return undefined;
  const text = value.trim();
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const candidate = hasTimezone
    ? text
    : /^\d{4}-\d{2}-\d{2}$/.test(text)
      ? `${text}T00:00:00+08:00`
      : `${text}+08:00`;
  const date = new Date(candidate);
  if (!Number.isFinite(date.getTime())) throw new ExportInputError(`${label}无效`);
  return date;
}

function parseStoredFilter(value: string): ExportFilter {
  try {
    return normalizeFilter(JSON.parse(value));
  } catch (error) {
    if (error instanceof ExportInputError) throw error;
    throw new Error('导出任务筛选条件损坏');
  }
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toDto(job: ExportJob): ExportJobDto {
  return {
    id: job.id,
    status: job.status as ExportJobStatusValue,
    filter: parseStoredFilter(job.filterSnapshot),
    snapshotAt: job.snapshotAt.toISOString(),
    progressTotal: job.progressTotal,
    progressDone: job.progressDone,
    progressErrors: job.progressErrors,
    currentSheet: job.currentSheet,
    currentItemLabel: job.currentItemLabel,
    fileName: job.fileName,
    fileSizeBytes: job.fileSizeBytes,
    error: job.error,
    attempt: job.attempt,
    cancelRequestedAt: toIso(job.cancelRequestedAt),
    expiresAt: toIso(job.expiresAt),
    createdAt: job.createdAt.toISOString(),
    startedAt: toIso(job.startedAt),
    completedAt: toIso(job.completedAt),
  };
}

function makeFileName(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `hot2-articles-export-${values.year}${values.month}${values.day}-${values.hour}${values.minute}${values.second}.xlsx`;
}

function assertSafeStorageKey(storageKey: string): void {
  if (!/^[0-9a-f-]{36}\.(?:xlsx|tmp|snapshot)$/i.test(storageKey)) throw new Error('Invalid export storage key');
}

function storagePath(storageKey: string): string {
  assertSafeStorageKey(storageKey);
  const target = path.resolve(EXPORT_STORAGE_DIR, storageKey);
  if (path.dirname(target) !== EXPORT_STORAGE_DIR) throw new Error('Invalid export storage path');
  return target;
}

async function ensureStorageDirectory(): Promise<void> {
  await mkdir(EXPORT_STORAGE_DIR, { recursive: true });
}

async function removeFile(storageKey: string): Promise<void> {
  if (!storageKey) return;
  try {
    await unlink(storagePath(storageKey));
  } catch (error: unknown) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
}

async function removeTempFile(storageKey: string): Promise<void> {
  if (!storageKey) return;
  try {
    await unlink(storagePath(storageKey.replace(/\.xlsx$/i, '.tmp')));
  } catch (error: unknown) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
}

async function removeSnapshotFile(storageKey: string): Promise<void> {
  if (!storageKey) return;
  try {
    await unlink(storagePath(storageKey.replace(/\.xlsx$/i, '.snapshot')));
  } catch (error: unknown) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
}

async function createSnapshotFile(storageKey: string): Promise<void> {
  const snapshotKey = storageKey.replace(/\.xlsx$/i, '.snapshot');
  await removeSnapshotFile(storageKey);
  const snapshotPath = storagePath(snapshotKey).replace(/\\/g, '/').replace(/'/g, "''");
  // The key is generated by this service and validated above. VACUUM INTO gives
  // the long-running export an immutable database file while progress and
  // cancellation continue writing to the live database.
  await db.$executeRawUnsafe(`VACUUM INTO '${snapshotPath}'`);
}

async function openReadSnapshot(storageKey: string): Promise<PrismaClient> {
  const snapshotKey = storageKey.replace(/\.xlsx$/i, '.snapshot');
  await stat(storagePath(snapshotKey));
  const snapshotPath = storagePath(snapshotKey).replace(/\\/g, '/');
  return new PrismaClient({ datasourceUrl: `file:${snapshotPath}` });
}

async function getJobOrThrow(id: string): Promise<ExportJob> {
  const job = await db.exportJob.findUnique({ where: { id } });
  if (!job) throw new ExportJobNotFoundError('导出任务不存在');
  return job;
}

export async function createExportJob(input: unknown): Promise<ExportJobDto> {
  const filter = normalizeFilter(input);
  if (exportMaintenanceInProgress) throw new ExportJobConflictError('数据清理进行中，请稍后重试');
  const snapshotAt = new Date();
  const storageKey = `${randomUUID()}.xlsx`;
  const job = await db.exportJob.create({
    data: {
      filterSnapshot: JSON.stringify(filter),
      snapshotAt,
      storageKey,
    },
  });
  try {
    await ensureStorageDirectory();
    await createSnapshotFile(storageKey);
    // VACUUM INTO 完成后再落边界，使快照内已复制记录的 createdAt/publishedAt
    // 不会被错误地排除；工作簿查询仍全部针对这份不可变副本。
    const boundary = await db.exportJob.updateMany({
      where: { id: job.id, status: 'queued' },
      data: { snapshotAt: new Date() },
    });
    if (boundary.count !== 1) throw new ExportJobConflictError('导出任务已取消或正在清理');
    const current = await db.exportJob.findUnique({ where: { id: job.id } });
    if (!current) throw new ExportJobConflictError('数据清理进行中，请稍后重试');
    if (current.status !== 'queued') {
      await removeSnapshotFile(storageKey).catch(() => undefined);
      return toDto(current);
    }
    if (exportMaintenanceInProgress) {
      await removeSnapshotFile(storageKey).catch(() => undefined);
      await db.exportJob.deleteMany({ where: { id: job.id, status: 'queued' } });
      throw new ExportJobConflictError('数据清理进行中，请稍后重试');
    }
  } catch (error: unknown) {
    await removeFile(storageKey).catch(() => undefined);
    await removeTempFile(storageKey).catch(() => undefined);
    await removeSnapshotFile(storageKey).catch(() => undefined);
    if (error instanceof ExportJobConflictError) throw error;
    const failed = await db.exportJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        completedAt: new Date(),
        error: '导出快照创建失败，请重试',
      },
    });
    return toDto(failed);
  }
  startExportWorker();
  return toDto(await getJobOrThrow(job.id));
}

export async function listExportJobs(): Promise<ExportJobDto[]> {
  await cleanupExpiredExportJobs();
  const jobs = await db.exportJob.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
  return jobs.map(toDto);
}

export async function getExportJob(id: string): Promise<ExportJobDto> {
  return toDto(await getJobOrThrow(id));
}

export async function cancelExportJob(id: string): Promise<ExportJobDto> {
  const job = await getJobOrThrow(id);
  if (job.status === 'queued') {
    const cancelled = await db.exportJob.updateMany({
      where: { id, status: 'queued' },
      data: { status: 'cancelled', completedAt: new Date(), error: '已取消' },
    });
    if (cancelled.count === 1) {
      await removeFile(job.storageKey).catch(() => undefined);
      await removeTempFile(job.storageKey).catch(() => undefined);
      await removeSnapshotFile(job.storageKey).catch(() => undefined);
      return toDto(await getJobOrThrow(id));
    }
    const current = await getJobOrThrow(id);
    if (current.status !== 'running') throw new ExportJobConflictError('当前任务无法取消');
    const requested = await db.exportJob.updateMany({ where: { id, status: 'running' }, data: { cancelRequestedAt: new Date() } });
    if (requested.count !== 1) return cancelExportJob(id);
    return toDto(await getJobOrThrow(id));
  }
  if (job.status !== 'running') throw new ExportJobConflictError('当前任务无法取消');
  const updated = await db.exportJob.updateMany({ where: { id, status: 'running' }, data: { cancelRequestedAt: new Date() } });
  if (updated.count !== 1) return cancelExportJob(id);
  return toDto(await getJobOrThrow(id));
}

export async function retryExportJob(id: string): Promise<ExportJobDto> {
  const job = await getJobOrThrow(id);
  if (!['failed', 'cancelled', 'expired'].includes(job.status)) {
    throw new ExportJobConflictError('只有失败、已取消或已过期的任务可以重试');
  }
  return createExportJob(parseStoredFilter(job.filterSnapshot));
}

async function claimNextExportJob(): Promise<ExportJob | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = await db.exportJob.findFirst({
      where: { status: 'queued' },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) return null;
    const claimed = await db.exportJob.updateMany({
      where: { id: candidate.id, status: 'queued' },
      data: {
        status: 'running',
        startedAt: new Date(),
        completedAt: null,
        cancelRequestedAt: null,
        error: '',
        attempt: { increment: 1 },
        workerToken: randomUUID(),
        currentSheet: 'Articles',
        currentItemLabel: '准备生成工作簿',
      },
    });
    if (claimed.count === 1) return db.exportJob.findUnique({ where: { id: candidate.id } });
  }
  return null;
}

async function recoverStaleExportJobs(): Promise<void> {
  const staleBefore = new Date(Date.now() - EXPORT_STALE_MS);
  const stale = await db.exportJob.findMany({
    where: { status: 'running', updatedAt: { lt: staleBefore } },
    select: { id: true, storageKey: true, workerToken: true },
  });
  for (const job of stale) {
    await removeFile(job.storageKey).catch((error) => console.error(`[export] failed to delete stale file for ${job.id}:`, error));
    await removeTempFile(job.storageKey).catch((error) => console.error(`[export] failed to delete stale temp file for ${job.id}:`, error));
    await removeSnapshotFile(job.storageKey).catch((error) => console.error(`[export] failed to delete stale snapshot for ${job.id}:`, error));
    await db.exportJob.updateMany({
      where: { id: job.id, status: 'running', workerToken: job.workerToken },
      data: { status: 'failed', workerToken: '', completedAt: new Date(), error: '导出任务因服务重启或超时中断' },
    });
  }
}

async function isCancelRequested(id: string, workerToken = ''): Promise<boolean> {
  const job = await db.exportJob.findUnique({ where: { id }, select: { status: true, workerToken: true, cancelRequestedAt: true } });
  return !job
    || job.status !== 'running'
    || (workerToken.length > 0 && job.workerToken !== workerToken)
    || Boolean(job.cancelRequestedAt);
}

async function updateProgress(id: string, workerToken: string, progress: ExportProgress): Promise<void> {
  if (await isCancelRequested(id, workerToken)) throw new ExportCancelledError('导出已取消');
  const updated = await db.exportJob.updateMany({
    where: { id, status: 'running', workerToken },
    data: {
      progressTotal: progress.total,
      progressDone: progress.done,
      currentSheet: progress.sheet,
      currentItemLabel: progress.label,
    },
  });
  if (updated.count !== 1) throw new ExportCancelledError('导出已取消');
}

async function processExportJob(job: ExportJob): Promise<void> {
  const storageKey = job.storageKey;
  let snapshotDb: PrismaClient | null = null;
  try {
    if (await isCancelRequested(job.id, job.workerToken)) throw new ExportCancelledError('导出已取消');
    await ensureStorageDirectory();
    if (!storageKey) throw new Error('导出快照不存在');
    await db.exportJob.updateMany({ where: { id: job.id, status: 'running', workerToken: job.workerToken }, data: { currentSheet: 'Articles' } });
    const filter = parseStoredFilter(job.filterSnapshot);
    snapshotDb = await openReadSnapshot(storageKey);
    const result = await buildExportWorkbook(
      snapshotDb,
      filter,
      job.snapshotAt,
      (progress) => updateProgress(job.id, job.workerToken, progress),
      {
        exportJobId: job.id,
        applicationVersion: process.env.npm_package_version,
        exportStartedAt: job.startedAt ?? new Date(),
      },
    );
    if (await isCancelRequested(job.id, job.workerToken)) throw new ExportCancelledError('导出已取消');
    const temporaryKey = storageKey.replace(/\.xlsx$/i, '.tmp');
    await writeFile(storagePath(temporaryKey), result.buffer);
    await rename(storagePath(temporaryKey), storagePath(storageKey));
    const completedAt = new Date();
    const success = await db.exportJob.updateMany({
      where: { id: job.id, status: 'running', workerToken: job.workerToken, cancelRequestedAt: null },
      data: {
        status: 'succeeded',
        progressTotal: result.progressTotal,
        progressDone: result.progressTotal,
        progressErrors: 0,
        currentSheet: '完成',
        currentItemLabel: `已生成 ${result.buffer.byteLength} bytes`,
        fileName: makeFileName(completedAt),
        fileSizeBytes: result.buffer.byteLength,
        completedAt,
        expiresAt: new Date(completedAt.getTime() + EXPORT_RETENTION_MS),
        error: '',
        workerToken: '',
      },
    });
    if (success.count !== 1) throw new ExportCancelledError('导出已取消');
  } catch (error: unknown) {
    await snapshotDb?.$disconnect().catch(() => undefined);
    await removeFile(storageKey).catch(() => undefined);
    await removeTempFile(storageKey).catch(() => undefined);
    await removeSnapshotFile(storageKey).catch(() => undefined);
    const cancelled = error instanceof ExportCancelledError || await isCancelRequested(job.id, job.workerToken).catch(() => false);
    await db.exportJob.updateMany({
      where: { id: job.id, status: 'running', workerToken: job.workerToken },
      data: {
        status: cancelled ? 'cancelled' : 'failed',
        completedAt: new Date(),
        currentSheet: cancelled ? '已取消' : '失败',
        currentItemLabel: '',
        progressErrors: cancelled ? 0 : { increment: 1 },
        error: cancelled ? '已取消' : 'Excel 文件生成失败，请重试',
        workerToken: '',
      },
    });
    if (!cancelled) console.error(`[export] job ${job.id} failed:`, error);
  } finally {
    if (snapshotDb) await snapshotDb.$disconnect().catch(() => undefined);
    await removeSnapshotFile(storageKey).catch(() => undefined);
  }
}

async function processExportQueue(): Promise<void> {
  await recoverStaleExportJobs();
  while (true) {
    const job = await claimNextExportJob();
    if (!job) return;
    await processExportJob(job);
  }
}

export function startExportWorker(): void {
  if (exportWorkerPromise) return;
  const promise = processExportQueue();
  exportWorkerPromise = promise;
  void promise.then(
    () => { if (exportWorkerPromise === promise) exportWorkerPromise = null; },
    (error) => {
      console.error('[export] worker stopped:', error);
      if (exportWorkerPromise === promise) exportWorkerPromise = null;
    },
  );
}

export async function cleanupExpiredExportJobs(now = new Date()): Promise<{ expired: number; filesDeleted: number }> {
  await recoverStaleExportJobs();
  const expired = await db.exportJob.findMany({
    where: { status: 'succeeded', expiresAt: { lt: now } },
    select: { id: true, storageKey: true, updatedAt: true },
  });
  let expiredCount = 0;
  let filesDeleted = 0;
  for (const job of expired) {
    try {
      await removeFile(job.storageKey);
      await removeTempFile(job.storageKey);
      await removeSnapshotFile(job.storageKey);
      filesDeleted += 1;
    } catch (error) {
      console.error(`[export] failed to delete expired file for ${job.id}:`, error);
      await db.exportJob.updateMany({
        where: { id: job.id, status: 'succeeded', updatedAt: job.updatedAt },
        data: { status: 'failed', error: '导出文件过期后未能删除，请稍后重试清理', completedAt: new Date() },
      });
      continue;
    }
    const updated = await db.exportJob.updateMany({
      where: { id: job.id, status: 'succeeded', updatedAt: job.updatedAt },
      data: { status: 'expired', storageKey: '', fileName: '', fileSizeBytes: null },
    });
    expiredCount += updated.count;
  }
  return { expired: expiredCount, filesDeleted };
}

export async function readExportFile(id: string): Promise<{ buffer: Buffer; fileName: string }> {
  const job = await getJobOrThrow(id);
  if (job.status !== 'succeeded' || !job.storageKey || !job.fileName) {
    throw new ExportJobConflictError('导出文件尚不可下载');
  }
  if (!job.expiresAt || job.expiresAt <= new Date()) {
    await cleanupExpiredExportJobs();
    throw new ExportJobNotFoundError('导出文件已过期');
  }
  try {
    const filePath = storagePath(job.storageKey);
    await stat(filePath);
    return { buffer: await readFile(filePath), fileName: job.fileName };
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new ExportJobNotFoundError('导出文件不存在');
    }
    throw error;
  }
}

/** 清理危险数据前删除尚未过期的导出文件，避免下载已被清空的业务数据快照。 */
async function performDeleteAllExportJobs(): Promise<number> {
  const now = new Date();
  await db.exportJob.updateMany({
    where: { status: 'queued' },
    data: { status: 'cancelled', completedAt: now, error: '因数据清理而取消' },
  });
  await db.exportJob.updateMany({
    where: { status: 'running' },
    data: { cancelRequestedAt: now },
  });
  if (exportWorkerPromise) {
    await exportWorkerPromise.catch(() => undefined);
  }
  const jobs = await db.exportJob.findMany({ select: { id: true, storageKey: true } });
  const deletableIds: string[] = [];
  const failedCleanupIds: string[] = [];
  for (const job of jobs) {
    let cleanupFailed = false;
    for (const remove of [removeFile, removeTempFile, removeSnapshotFile]) {
      try {
        await remove(job.storageKey);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) failedCleanupIds.push(job.id);
    else deletableIds.push(job.id);
  }
  if (failedCleanupIds.length > 0) {
    await db.exportJob.updateMany({
      where: { id: { in: failedCleanupIds } },
      data: {
        status: 'failed',
        cancelRequestedAt: null,
        workerToken: '',
        completedAt: new Date(),
        error: '数据清理后导出文件未能删除，请稍后重试清理',
      },
    });
  }
  const result = deletableIds.length === 0
    ? { count: 0 }
    : await db.exportJob.deleteMany({ where: { id: { in: deletableIds } } });
  return result.count;
}

export function deleteAllExportJobs(): Promise<number> {
  if (exportMaintenancePromise) return exportMaintenancePromise;
  exportMaintenanceInProgress = true;
  const promise = performDeleteAllExportJobs().finally(() => {
    exportMaintenanceInProgress = false;
    exportMaintenancePromise = null;
  });
  exportMaintenancePromise = promise;
  return promise;
}

export type { ExportJobStatus };
