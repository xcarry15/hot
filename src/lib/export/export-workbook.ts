import type { Prisma, PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';
import { EXPORT_FORMAT_VERSION, type ExportFilter } from '@/contracts/data-export';

export const EXPORT_BATCH_SIZE = 250;
export const EXPORT_CONTENT_CHUNK_SIZE = 30_000;

type ExportDb = PrismaClient | Prisma.TransactionClient;
type CellValue = string | number | boolean | Date | null | undefined;
type SheetRow = CellValue[];

export interface ExportProgress {
  total: number;
  done: number;
  sheet: string;
  label: string;
}

export interface ExportWorkbookResult {
  buffer: Buffer;
  counts: Record<string, number>;
  mainRecordTotal: number;
  progressTotal: number;
}

export interface ExportWorkbookOptions {
  exportJobId: string;
  applicationVersion?: string;
  exportStartedAt?: Date;
}

interface LongTextSink {
  append(rows: SheetRow[]): void;
}

interface SheetBuilder {
  append(rows: SheetRow[]): void;
  count: number;
}

const MAX_EXCEL_CELL_TEXT_LENGTH = 32_767;
const SENSITIVE_KEY_PATTERN = /(?:api[-_]?key|access[-_]?token|client[-_]?secret|authorization|proxy[-_]?authorization|cookie|credential|password|secret|signature|webhook|(?:^|[_-])token$|(?:^|[_-])key$)/i;
const SENSITIVE_QUERY_KEY_PATTERN = /(?:api[-_]?key|access[-_]?token|client[-_]?secret|authorization|auth|cookie|credential|password|secret|signature|sig|token|webhook|key)/i;
const STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  fetched: '已抓取',
  failed: '失败',
  clustered: '已聚类',
  needs_review: '待复核',
  done: '已完成',
  skipped: '已跳过',
  unpublished: '未公开',
  published: '已公开',
  revoked: '已撤回',
  active: '有效',
  never_fetched: '未抓取',
  normal: '正常',
  breaker: '熔断中',
  merged: '已合并',
  confirmed: '已确认',
  queued: '排队中',
  running: '运行中',
  cancel_requested: '取消中',
  succeeded: '成功',
  completed: '已完成',
  cancelled: '已取消',
  success: '成功',
  failure: '失败',
  warning: '警告',
  sending: '发送中',
  disabled: '已停用',
  ignored: '已忽略',
  applied: '已应用',
  dismissed: '已驳回',
  approved: '已批准',
  unknown: '未知',
};

const ARTICLE_HEADERS = [
  'articleId', 'sourceId', 'sourceName', 'url', 'title', 'originalSource', 'contentHash',
  'rawContentLength', 'cleanContentLength', 'articleBodyLength', 'searchText', 'searchIndexUpdatedAt',
  'eventId', 'clusterStatus', 'clusterStatusLabel', 'clusteredAt', 'clusterError', 'clusterRetryCount', 'nextClusterRetryAt',
  'eventSubjects', 'eventAction', 'eventObject', 'eventKey', 'eventKeyConfidence',
  'fetchStatus', 'fetchStatusLabel', 'fetchError', 'fetchRetryCount', 'nextFetchRetryAt', 'technicalIgnoredAt',
  'relevance', 'summary', 'brand', 'category', 'keyPoints', 'score', 'keywordMatched',
  'eventScore', 'contentScore', 'rawScore', 'adProbability', 'aiConfidence',
  'scorePolicyVersion', 'aiModel', 'aiProvider', 'promptHash', 'scorePolicySnapshot',
  'promptVersion', 'aiStatus', 'aiStatusLabel', 'aiError', 'aiSnapshot', 'manualOverrides', 'manualCorrectedAt',
  'skipReason', 'aiRetryCount', 'nextAiRetryAt', 'isAd',
  'publicOverride', 'publicStatus', 'publicStatusLabel', 'publicPublishedAt', 'publicRevokedAt',
  'publicPublicationReason', 'publicPublicationEvaluatedAt', 'publicContentUpdatedAt',
  'viewCount', 'originalClickCount', 'publishedAt', 'createdAt', 'updatedAt',
  'isRepresentative', 'representativeEventId', 'eventStatus', 'eventStatusLabel', 'eventPushedAt',
] as const;

const ARTICLE_CONTENT_HEADERS = ['articleId', 'contentType', 'chunkNo', 'chunkTotal', 'contentChunk'] as const;
const EVENT_HEADERS = [
  'eventId', 'status', 'statusLabel', 'clusterReviewStatus', 'clusterReviewStatusLabel', 'mergedIntoId', 'representativeArticleId',
  'representativeManual', 'firstSeenAt', 'lastSeenAt', 'articleCount', 'publicStatus',
  'publicStatusLabel', 'publicPublishedAt', 'publicRevokedAt', 'publicDateKey', 'publicSortAt', 'pushedAt',
  'viewCount', 'originalClickCount', 'nextPushRetryAt', 'pushRetryCount', 'createdAt', 'updatedAt',
  'dirtyReason',
] as const;
const ARTICLE_EVENT_HEADERS = [
  'articleId', 'eventId', 'isRepresentative', 'representativeManual', 'eventStatus', 'eventStatusLabel', 'eventKey',
] as const;
const EVENT_AUDIT_HEADERS = [
  'auditId', 'articleId', 'assignedEventId', 'candidateEventId', 'actor', 'action',
  'decisionSource', 'confidence', 'evidence', 'createdAt',
] as const;
const SOURCE_HEADERS = [
  'sourceId', 'name', 'type', 'url', 'parserConfig', 'enabled', 'publicEnabled', 'status', 'statusLabel',
  'consecutiveFailures', 'circuitBreakerUntil', 'lastFetchedAt', 'createdAt', 'updatedAt', 'deletedAt',
] as const;
const FETCH_LOG_HEADERS = ['fetchLogId', 'sourceId', 'status', 'statusLabel', 'errorMessage', 'itemsFound', 'createdAt'] as const;
const JOB_HEADERS = [
  'jobId', 'type', 'status', 'statusLabel', 'payload', 'result', 'error', 'currentStage', 'progressTotal',
  'progressDone', 'progressErrors', 'currentItemLabel', 'heartbeatAt', 'leaseOwner',
  'leaseExpiresAt', 'attempt', 'maxAttempts', 'idempotencyKey', 'availableAt', 'cancelRequestedAt',
  'createdAt', 'updatedAt', 'startedAt', 'completedAt',
] as const;
const PUSH_TARGET_HEADERS = ['targetId', 'name', 'urlHash', 'enabled', 'createdAt', 'updatedAt'] as const;
const PUSH_DELIVERY_HEADERS = [
  'deliveryId', 'eventId', 'targetId', 'representativeArticleId', 'contentVersion', 'mode',
  'status', 'statusLabel', 'idempotencyKey', 'attempt', 'lastError', 'leaseOwner', 'leaseExpiresAt',
  'createdAt', 'updatedAt', 'sentAt', 'completedAt',
] as const;
const PUSH_LOG_HEADERS = [
  'pushLogId', 'eventId', 'representativeArticleId', 'targetId', 'status', 'statusLabel', 'errorMessage',
  'retryCount', 'webhookRemark', 'createdAt',
] as const;
const INTERACTION_HEADERS = [
  'eventId', 'sourceId', 'dateKey', 'viewCount', 'originalClickCount', 'createdAt', 'updatedAt',
] as const;
const KEYWORD_HIT_HEADERS = ['articleId', 'keywordId', 'createdAt'] as const;
const KEYWORD_HEADERS = ['keywordId', 'category', 'word', 'createdAt'] as const;
const KEYWORD_CANDIDATE_HEADERS = ['candidateId', 'phrase', 'occurrences', 'sampleTitles', 'status', 'statusLabel', 'createdAt', 'updatedAt'] as const;
const TUNING_HEADERS = ['suggestionId', 'kind', 'title', 'detail', 'payload', 'status', 'statusLabel', 'createdAt', 'appliedAt'] as const;
const DISCARDED_HEADERS = [
  'discardedId', 'sourceId', 'title', 'url', 'reason', 'detail', 'winnerArticleId', 'publishedAt', 'createdAt',
] as const;
const DISCARDED_AUDIT_HEADERS = [
  'auditId', 'discardedId', 'sourceId', 'title', 'url', 'reason', 'detail', 'winnerArticleId',
  'publishedAt', 'action', 'articleId', 'createdAt',
] as const;
const LONG_TEXT_HEADERS = ['sheetName', 'rowKey', 'field', 'chunkNo', 'chunkTotal', 'valueChunk'] as const;

function dateCell(value: Date | null | undefined): Date | '' {
  return value instanceof Date ? value : '';
}

function jsonText(value: string | null | undefined): string {
  return value ?? '';
}

function redactUnknown(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactUnknown(childValue, childKey),
    ]));
  }
  if (typeof value === 'string') return redactSensitiveText(value);
  return value;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n,;]+)/gi, 'Authorization=[REDACTED]')
    .replace(/\b(?:cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, 'Cookie=[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(
    /((?:api[-_]?key|access[-_]?token|client[-_]?secret|authorization|cookie|credential|password|secret|signature|token|webhook))\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    '$1=[REDACTED]',
    );
}

function redactJson(value: string | null | undefined): string {
  if (!value) return '';
  try {
    return JSON.stringify(redactUnknown(JSON.parse(value)));
  } catch {
    return redactSensitiveText(value);
  }
}

function safeUrl(value: string | null | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) url.searchParams.delete(key);
    }
    if (SENSITIVE_QUERY_KEY_PATTERN.test(url.hash)) url.hash = '';
    const pathSegments = url.pathname.split('/');
    for (let index = 1; index < pathSegments.length; index += 1) {
      if (SENSITIVE_QUERY_KEY_PATTERN.test(pathSegments[index - 1])) pathSegments[index] = '[REDACTED]';
    }
    url.pathname = pathSegments.join('/');
    return redactSensitiveText(url.toString());
  } catch {
    return redactSensitiveText(value);
  }
}

function createSheetBuilder(
  workbook: XLSX.WorkBook,
  name: string,
  headers: readonly string[],
  widths: number[] = [],
  longTextSink?: LongTextSink,
): SheetBuilder {
  const sheet = XLSX.utils.aoa_to_sheet([[...headers]]);
  if (widths.length > 0) sheet['!cols'] = widths.map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(workbook, sheet, name);
  let count = 0;

  return {
    get count() {
      return count;
    },
    append(rows: SheetRow[]) {
      if (rows.length === 0) return;
      const normalizedRows = rows.map((row) => row.map((value, columnIndex) => {
        if (!longTextSink || typeof value !== 'string' || value.length <= MAX_EXCEL_CELL_TEXT_LENGTH) return value;
        const chunks = Math.ceil(value.length / EXPORT_CONTENT_CHUNK_SIZE);
        longTextSink.append(Array.from({ length: chunks }, (_, chunkIndex) => [
          name,
          String(row[0] ?? ''),
          headers[columnIndex] ?? `column_${columnIndex + 1}`,
          chunkIndex + 1,
          chunks,
          value.slice(chunkIndex * EXPORT_CONTENT_CHUNK_SIZE, (chunkIndex + 1) * EXPORT_CONTENT_CHUNK_SIZE),
        ]));
        return `[已分片至 LongTextChunks：${headers[columnIndex] ?? `column_${columnIndex + 1}`}]`;
      }));
      const startRow = count + 1;
      XLSX.utils.sheet_add_aoa(sheet, normalizedRows, { origin: { r: startRow, c: 0 } });
      normalizedRows.forEach((row, rowIndex) => {
        row.forEach((value, columnIndex) => {
          const address = XLSX.utils.encode_cell({ r: startRow + rowIndex, c: columnIndex });
          const cell = (sheet[address] ?? {}) as { t?: string; v?: unknown; f?: string; z?: string };
          if (typeof value === 'string' || value === null || value === undefined) {
            cell.t = 's';
            cell.v = value ?? '';
            delete cell.f;
          } else if (value instanceof Date) {
            cell.t = 'd';
            cell.v = value;
            cell.z = 'yyyy-mm-dd hh:mm:ss';
            delete cell.f;
          }
          sheet[address] = cell as XLSX.CellObject;
        });
      });
      count += rows.length;
    },
  };
}

function splitIds(ids: Set<string>): string[][] {
  const values = [...ids];
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += 500) chunks.push(values.slice(index, index + 500));
  return chunks;
}

async function appendByIdChunksPaged<T extends { id: string }>(
  ids: Set<string>,
  load: (chunk: string[], cursor?: string) => Promise<T[]>,
  append: (rows: T[]) => void | Promise<void>,
): Promise<void> {
  for (const chunk of splitIds(ids)) {
    let cursor: string | undefined;
    while (true) {
      const page = await load(chunk, cursor);
      if (page.length === 0) break;
      await append(page);
      if (page.length < EXPORT_BATCH_SIZE) break;
      cursor = page[page.length - 1].id;
    }
  }
}

async function appendIdPages<T extends { id: string }>(
  load: (cursor?: string) => Promise<T[]>,
  append: (rows: T[]) => void | Promise<void>,
): Promise<void> {
  let cursor: string | undefined;
  while (true) {
    const page = await load(cursor);
    if (page.length === 0) break;
    await append(page);
    if (page.length < EXPORT_BATCH_SIZE) break;
    cursor = page[page.length - 1].id;
  }
}

interface KeywordHitCursor {
  articleId: string;
  keywordId: string;
}

async function appendKeywordHitPages<T extends { articleId: string; keywordId: string }>(
  load: (cursor?: KeywordHitCursor) => Promise<T[]>,
  append: (rows: T[]) => void | Promise<void>,
): Promise<void> {
  let cursor: KeywordHitCursor | undefined;
  while (true) {
    const page = await load(cursor);
    if (page.length === 0) break;
    await append(page);
    if (page.length < EXPORT_BATCH_SIZE) break;
    const last = page[page.length - 1];
    cursor = { articleId: last.articleId, keywordId: last.keywordId };
  }
}

interface InteractionCursor {
  eventId: string;
  sourceId: string;
  dateKey: string;
}

async function appendInteractionPages<T extends { eventId: string; sourceId: string; dateKey: string }>(
  load: (cursor?: InteractionCursor) => Promise<T[]>,
  append: (rows: T[]) => void | Promise<void>,
): Promise<void> {
  let cursor: InteractionCursor | undefined;
  while (true) {
    const page = await load(cursor);
    if (page.length === 0) break;
    await append(page);
    if (page.length < EXPORT_BATCH_SIZE) break;
    const last = page[page.length - 1];
    cursor = { eventId: last.eventId, sourceId: last.sourceId, dateKey: last.dateKey };
  }
}

function parseDate(value: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function isUnboundedFilter(filter: ExportFilter): boolean {
  return filter.dateField === 'createdAt'
    && !filter.from
    && !filter.to
    && filter.sourceIds.length === 0
    && filter.fetchStatuses.length === 0
    && filter.aiStatuses.length === 0
    && filter.clusterStatuses.length === 0
    && filter.publicStatuses.length === 0
    && filter.representative === 'all'
    && filter.pushed === 'all'
    && !filter.eventId;
}

function buildArticleWhere(filter: ExportFilter, snapshotAt: Date): Prisma.ArticleWhereInput {
  const conditions: Prisma.ArticleWhereInput[] = [{ createdAt: { lte: snapshotAt } }];
  if (filter.sourceIds.length > 0) conditions.push({ sourceId: { in: filter.sourceIds } });
  if (filter.fetchStatuses.length > 0) conditions.push({ fetchStatus: { in: filter.fetchStatuses } });
  if (filter.aiStatuses.length > 0) conditions.push({ aiStatus: { in: filter.aiStatuses } });
  if (filter.clusterStatuses.length > 0) conditions.push({ clusterStatus: { in: filter.clusterStatuses } });
  if (filter.publicStatuses.length > 0) conditions.push({ publicStatus: { in: filter.publicStatuses } });
  if (filter.eventId) conditions.push({ eventId: filter.eventId });
  if (filter.representative === 'yes') conditions.push({ representedEvent: { isNot: null } });
  if (filter.representative === 'no') conditions.push({ representedEvent: { is: null } });
  if (filter.pushed === 'yes') conditions.push({ event: { is: { pushedAt: { not: null } } } });
  if (filter.pushed === 'no') {
    conditions.push({ OR: [{ event: { is: null } }, { event: { is: { pushedAt: null } } }] });
  }

  const from = parseDate(filter.from);
  const to = parseDate(filter.to);
  if (filter.dateField === 'createdAt') {
    conditions[0] = { createdAt: { lte: snapshotAt, ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } };
  } else if (filter.dateField === 'publishedAt') {
    conditions.push({ publishedAt: { lte: snapshotAt, ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } });
  } else {
    conditions.push({ updatedAt: { lte: snapshotAt, ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } });
  }
  return { AND: conditions };
}

function buildDiscardedWhere(filter: ExportFilter, snapshotAt: Date): Prisma.DiscardedItemWhereInput {
  const where: Prisma.DiscardedItemWhereInput = { createdAt: { lte: snapshotAt } };
  if (filter.sourceIds.length > 0) where.sourceId = { in: filter.sourceIds };
  const from = parseDate(filter.from);
  const to = parseDate(filter.to);
  if (filter.dateField === 'publishedAt') {
    where.publishedAt = { lte: snapshotAt, ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) };
  } else if (filter.dateField === 'createdAt' || filter.dateField === 'updatedAt') {
    where.createdAt = { lte: snapshotAt, ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) };
  }
  return where;
}

function contentRows(articleId: string, contentType: string, content: string): SheetRow[] {
  const total = Math.max(1, Math.ceil(content.length / EXPORT_CONTENT_CHUNK_SIZE));
  const rows: SheetRow[] = [];
  for (let index = 0; index < total; index += 1) {
    rows.push([
      articleId,
      contentType,
      index + 1,
      total,
      content.slice(index * EXPORT_CONTENT_CHUNK_SIZE, (index + 1) * EXPORT_CONTENT_CHUNK_SIZE),
    ]);
  }
  return rows;
}

function makeArticleRow(article: Prisma.ArticleGetPayload<{
  include: {
    source: true;
    searchIndex: true;
    event: { select: { id: true; status: true; pushedAt: true } };
    representedEvent: { select: { id: true; representativeManual: true } };
  };
}>): SheetRow {
  return [
    article.id,
    article.sourceId,
    article.source.name,
    safeUrl(article.url),
    article.title,
    article.originalSource ?? '',
    article.contentHash,
    article.rawContent.length,
    article.cleanContent.length,
    article.articleBody.length,
    article.searchIndex?.searchText ?? '',
    dateCell(article.searchIndex?.updatedAt),
    article.eventId ?? '',
    article.clusterStatus,
    STATUS_LABELS[article.clusterStatus] ?? article.clusterStatus,
    dateCell(article.clusteredAt),
    redactSensitiveText(article.clusterError ?? ''),
    article.clusterRetryCount,
    dateCell(article.nextClusterRetryAt),
    jsonText(article.eventSubjects),
    article.eventAction,
    article.eventObject,
    article.eventKey,
    article.eventKeyConfidence,
    article.fetchStatus,
    STATUS_LABELS[article.fetchStatus] ?? article.fetchStatus,
    redactSensitiveText(article.fetchError ?? ''),
    article.fetchRetryCount,
    dateCell(article.nextFetchRetryAt),
    dateCell(article.technicalIgnoredAt),
    article.relevance,
    article.summary,
    article.brand,
    article.category,
    jsonText(article.keyPoints),
    article.score,
    article.keywordMatched,
    article.eventScore,
    article.contentScore,
    article.rawScore,
    article.adProbability,
    article.aiConfidence,
    article.scorePolicyVersion,
    article.aiModel,
    article.aiProvider,
    article.promptHash,
    redactJson(article.scorePolicySnapshot),
    article.promptVersion,
    article.aiStatus,
    STATUS_LABELS[article.aiStatus] ?? article.aiStatus,
    redactSensitiveText(article.aiError ?? ''),
    redactJson(article.aiSnapshot),
    redactJson(article.manualOverrides),
    dateCell(article.manualCorrectedAt),
    redactSensitiveText(article.skipReason ?? ''),
    article.aiRetryCount,
    dateCell(article.nextAiRetryAt),
    article.isAd,
    article.publicOverride,
    article.publicStatus,
    STATUS_LABELS[article.publicStatus] ?? article.publicStatus,
    dateCell(article.publicPublishedAt),
    dateCell(article.publicRevokedAt),
    article.publicPublicationReason,
    dateCell(article.publicPublicationEvaluatedAt),
    dateCell(article.publicContentUpdatedAt),
    article.viewCount,
    article.originalClickCount,
    dateCell(article.publishedAt),
    dateCell(article.createdAt),
    dateCell(article.updatedAt),
    Boolean(article.representedEvent),
    article.representedEvent?.id ?? '',
    article.event?.status ?? '',
    STATUS_LABELS[article.event?.status ?? ''] ?? article.event?.status ?? '',
    dateCell(article.event?.pushedAt),
  ];
}

function makeEventRow(
  event: Prisma.EventGetPayload<object>,
  dirtyReason: string,
): SheetRow {
  return [
    event.id,
    event.status,
    STATUS_LABELS[event.status] ?? event.status,
    event.clusterReviewStatus,
    STATUS_LABELS[event.clusterReviewStatus] ?? event.clusterReviewStatus,
    event.mergedIntoId ?? '',
    event.representativeArticleId ?? '',
    event.representativeManual,
    dateCell(event.firstSeenAt),
    dateCell(event.lastSeenAt),
    event.articleCount,
    event.publicStatus,
    STATUS_LABELS[event.publicStatus] ?? event.publicStatus,
    dateCell(event.publicPublishedAt),
    dateCell(event.publicRevokedAt),
    event.publicDateKey,
    dateCell(event.publicSortAt),
    dateCell(event.pushedAt),
    event.viewCount,
    event.originalClickCount,
    dateCell(event.nextPushRetryAt),
    event.pushRetryCount,
    dateCell(event.createdAt),
    dateCell(event.updatedAt),
    dirtyReason,
  ];
}

export async function buildExportWorkbook(
  tx: ExportDb,
  filter: ExportFilter,
  snapshotAt: Date,
  onProgress?: (progress: ExportProgress) => Promise<void>,
  options: ExportWorkbookOptions = { exportJobId: '' },
): Promise<ExportWorkbookResult> {
  const workbook = XLSX.utils.book_new();
  const sheets: Record<string, SheetBuilder> = {};
  const add = (name: string, headers: readonly string[], widths: number[] = []) => {
    sheets[name] = createSheetBuilder(workbook, name, headers, widths, name === 'LongTextChunks' ? undefined : sheets.LongTextChunks);
  };

  add('LongTextChunks', LONG_TEXT_HEADERS, [24, 24, 32, 12, 12, 100]);
  add('ExportMeta', ['key', 'value'], [30, 80]);
  add('Articles', ARTICLE_HEADERS, [24, 18, 24, 48, 48, 24, 24, 16, 16, 16, 48]);
  add('ArticleContent', ARTICLE_CONTENT_HEADERS, [24, 18, 12, 12, 100]);
  add('Events', EVENT_HEADERS, [24, 16, 18, 24, 24, 16, 24, 24, 12, 18, 24, 24, 16, 24, 24, 12, 16, 24, 16, 24, 24, 24]);
  add('ArticleEventRelations', ARTICLE_EVENT_HEADERS, [24, 24, 16, 18, 16, 18, 48]);
  add('EventClusterAudits', EVENT_AUDIT_HEADERS, [24, 24, 24, 24, 16, 24, 18, 12, 80, 24]);
  add('Sources', SOURCE_HEADERS, [24, 28, 16, 48, 80, 12, 14, 18, 16, 24, 24, 24, 24, 24]);
  add('FetchLogs', FETCH_LOG_HEADERS, [24, 24, 16, 80, 12, 24]);
  add('Jobs', JOB_HEADERS, [24, 16, 18, 48, 80, 80, 16, 16, 16, 16, 32, 24, 24, 24, 12, 12, 32, 24, 24, 24, 24, 24, 24]);
  add('PushTargets', PUSH_TARGET_HEADERS, [24, 28, 48, 12, 24, 24]);
  add('PushDeliveries', PUSH_DELIVERY_HEADERS, [24, 24, 24, 24, 24, 16, 18, 48, 12, 80, 24, 24, 24, 24, 24, 24]);
  add('PushLogs', PUSH_LOG_HEADERS, [24, 24, 24, 24, 16, 80, 12, 32, 24]);
  add('EventInteractionDaily', INTERACTION_HEADERS, [24, 24, 16, 16, 20, 24, 24]);
  add('KeywordHits', KEYWORD_HIT_HEADERS, [24, 24, 24]);
  add('Keywords', KEYWORD_HEADERS, [24, 16, 48, 24]);
  add('KeywordCandidates', KEYWORD_CANDIDATE_HEADERS, [24, 48, 16, 80, 16, 24, 24]);
  add('TuningSuggestions', TUNING_HEADERS, [24, 28, 48, 80, 80, 16, 24, 24]);
  add('DiscardedItems', DISCARDED_HEADERS, [24, 24, 48, 48, 24, 80, 24, 24, 24]);
  add('DiscardedRetryAudits', DISCARDED_AUDIT_HEADERS, [24, 24, 24, 48, 48, 24, 80, 24, 24, 16, 24, 24]);

  const articleIds = new Set<string>();
  const eventIds = new Set<string>();
  const sourceIds = new Set<string>();
  const discardedIds = new Set<string>();
  const targetIds = new Set<string>();
  const articleWhere = buildArticleWhere(filter, snapshotAt);
  const discardedWhere = buildDiscardedWhere(filter, snapshotAt);
  const fullScope = isUnboundedFilter(filter);
  const articleTotal = await tx.article.count({ where: articleWhere });
  const discardedTotal = filter.includeDiscarded ? await tx.discardedItem.count({ where: discardedWhere }) : 0;
  const mainRecordTotal = articleTotal + discardedTotal;
  const progressTotal = Math.max(1, mainRecordTotal + 1);
  let mainDone = 0;
  const checkpoint = (sheet: string, label: string) => onProgress?.({ total: progressTotal, done: mainDone, sheet, label });
  await checkpoint('Articles', `准备导出 ${articleTotal} 篇文章`);

  let articleCursor: string | undefined;
  while (true) {
    const page = await tx.article.findMany({
      where: articleWhere,
      include: {
        source: true,
        searchIndex: true,
        event: { select: { id: true, status: true, pushedAt: true } },
        representedEvent: { select: { id: true, representativeManual: true } },
      },
      orderBy: { id: 'asc' },
      take: EXPORT_BATCH_SIZE,
      ...(articleCursor ? { skip: 1, cursor: { id: articleCursor } } : {}),
    });
    if (page.length === 0) break;
    sheets.Articles.append(page.map(makeArticleRow));
    sheets.ArticleEventRelations.append(page.map((article) => [
      article.id,
      article.eventId ?? '',
      Boolean(article.representedEvent),
      Boolean(article.representedEvent?.representativeManual),
      article.event?.status ?? '',
      STATUS_LABELS[article.event?.status ?? ''] ?? article.event?.status ?? '',
      article.eventKey,
    ]));
    for (const article of page) {
      articleIds.add(article.id);
      sourceIds.add(article.sourceId);
      if (article.eventId) eventIds.add(article.eventId);
      sheets.ArticleContent.append([
        ...contentRows(article.id, 'rawContent', article.rawContent),
        ...contentRows(article.id, 'cleanContent', article.cleanContent),
        ...contentRows(article.id, 'articleBody', article.articleBody),
      ]);
    }
    mainDone += page.length;
    await checkpoint('Articles', `已读取 ${mainDone}/${mainRecordTotal} 条主记录`);
    articleCursor = page[page.length - 1].id;
  }

  if (filter.includeDiscarded) {
    let discardedCursor: string | undefined;
    await checkpoint('DiscardedItems', `准备导出 ${discardedTotal} 条未入库记录`);
    while (true) {
      const page = await tx.discardedItem.findMany({
        where: discardedWhere,
        orderBy: { id: 'asc' },
        take: EXPORT_BATCH_SIZE,
        ...(discardedCursor ? { skip: 1, cursor: { id: discardedCursor } } : {}),
      });
      if (page.length === 0) break;
      sheets.DiscardedItems.append(page.map((item) => [
        item.id,
        item.sourceId,
        item.title,
        safeUrl(item.url),
        item.reason,
        redactJson(item.detail),
        item.winnerArticleId ?? '',
        dateCell(item.publishedAt),
        dateCell(item.createdAt),
      ]));
      for (const item of page) {
        discardedIds.add(item.id);
        sourceIds.add(item.sourceId);
      }
      mainDone += page.length;
      await checkpoint('DiscardedItems', `已读取 ${mainDone}/${mainRecordTotal} 条主记录`);
      discardedCursor = page[page.length - 1].id;
    }
  }

  const dirtyMap = new Map<string, string>();
  const selectedEventRows: Prisma.EventGetPayload<object>[] = [];
  if (fullScope) {
    await appendIdPages(
      (cursor) => tx.eventDirty.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      async (rows) => {
        rows.forEach((row) => dirtyMap.set(row.eventId, row.reason));
        await checkpoint('Events', `已读取 ${rows.length} 条 Event 标记`);
      },
    );
    await appendIdPages(
      (cursor) => tx.event.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      async (rows) => {
        rows.forEach((event) => eventIds.add(event.id));
        sheets.Events.append(rows.map((event) => makeEventRow(event, dirtyMap.get(event.id) ?? '')));
        await checkpoint('Events', `已写入 ${sheets.Events.count} 个 Event`);
      },
    );
  } else {
    const pendingEventIds = new Set(eventIds);
    const loadedEventIds = new Set<string>();
    while (pendingEventIds.size > 0) {
      const batch = new Set(pendingEventIds);
      pendingEventIds.clear();
      await appendByIdChunksPaged(
        batch,
        (chunk, cursor) => tx.event.findMany({ where: { id: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
        async (rows) => {
          for (const event of rows) {
            if (loadedEventIds.has(event.id)) continue;
            loadedEventIds.add(event.id);
            eventIds.add(event.id);
            selectedEventRows.push(event);
            if (event.mergedIntoId && !loadedEventIds.has(event.mergedIntoId)) pendingEventIds.add(event.mergedIntoId);
          }
          await checkpoint('Events', `已读取 ${selectedEventRows.length} 个 Event`);
        },
      );
    }
    await appendByIdChunksPaged(
      eventIds,
      (chunk, cursor) => tx.eventDirty.findMany({ where: { eventId: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      (rows) => rows.forEach((row) => dirtyMap.set(row.eventId, row.reason)),
    );
    sheets.Events.append(selectedEventRows.map((event) => makeEventRow(event, dirtyMap.get(event.id) ?? '')));
    await checkpoint('Events', `已写入 ${sheets.Events.count} 个 Event`);
  }

  const appendClusterAudits = async (rows: Prisma.EventClusterAuditGetPayload<object>[]) => {
    sheets.EventClusterAudits.append(rows.map((row) => [
      row.id,
      row.articleId,
      row.assignedEventId,
      row.candidateEventId ?? '',
      row.actor,
      row.action,
      row.decisionSource,
      row.confidence,
      redactJson(row.evidence),
      dateCell(row.createdAt),
    ]));
    await checkpoint('EventClusterAudits', `已写入 ${sheets.EventClusterAudits.count} 条聚类审计`);
  };
  if (fullScope) {
    await appendIdPages(
      (cursor) => tx.eventClusterAudit.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      appendClusterAudits,
    );
  } else {
    await appendByIdChunksPaged(
      articleIds,
      (chunk, cursor) => tx.eventClusterAudit.findMany({ where: { articleId: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      appendClusterAudits,
    );
  }

  const appendSourceRows = async (rows: Prisma.SourceGetPayload<object>[]) => {
    sheets.Sources.append(rows.map((source) => [
      source.id,
      source.name,
      source.type,
      safeUrl(source.url),
      redactJson(source.parserConfig),
      source.enabled,
      source.publicEnabled,
      source.status,
      STATUS_LABELS[source.status] ?? source.status,
      source.consecutiveFailures,
      dateCell(source.circuitBreakerUntil),
      dateCell(source.lastFetchedAt),
      dateCell(source.createdAt),
      dateCell(source.updatedAt),
      dateCell(source.deletedAt),
    ]));
    await checkpoint('Sources', `已写入 ${sheets.Sources.count} 个数据源`);
  };
  if (fullScope) {
    await appendIdPages(
      (cursor) => tx.source.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      appendSourceRows,
    );
  } else {
    await appendByIdChunksPaged(
      sourceIds,
      (chunk, cursor) => tx.source.findMany({ where: { id: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      appendSourceRows,
    );
  }

  const appendFetchLogs = async (rows: Prisma.FetchLogGetPayload<object>[]) => {
    sheets.FetchLogs.append(rows.map((row) => [
      row.id,
      row.sourceId,
      row.status,
      STATUS_LABELS[row.status] ?? row.status,
      redactSensitiveText(row.errorMessage),
      row.itemsFound,
      dateCell(row.createdAt),
    ]));
    await checkpoint('FetchLogs', `已写入 ${sheets.FetchLogs.count} 条抓取日志`);
  };
  if (fullScope) {
    await appendIdPages(
      (cursor) => tx.fetchLog.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      appendFetchLogs,
    );
  } else {
    await appendByIdChunksPaged(
      sourceIds,
      (chunk, cursor) => tx.fetchLog.findMany({ where: { sourceId: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      appendFetchLogs,
    );
  }

  const appendJobs = async (rows: Prisma.JobGetPayload<object>[]) => {
    sheets.Jobs.append(rows.map((job) => [
      job.id,
      job.type,
      job.status,
      STATUS_LABELS[job.status] ?? job.status,
      redactJson(job.payload),
      redactJson(job.result),
      redactSensitiveText(job.error),
      job.currentStage ?? '',
      job.progressTotal,
      job.progressDone,
      job.progressErrors,
      job.currentItemLabel,
      dateCell(job.heartbeatAt),
      job.leaseOwner,
      dateCell(job.leaseExpiresAt),
      job.attempt,
      job.maxAttempts,
      job.idempotencyKey,
      dateCell(job.availableAt),
      dateCell(job.cancelRequestedAt),
      dateCell(job.createdAt),
      dateCell(job.updatedAt),
      dateCell(job.startedAt),
      dateCell(job.completedAt),
    ]));
    await checkpoint('Jobs', `已写入 ${sheets.Jobs.count} 个流水线 Job`);
  };
  await appendIdPages(
    (cursor) => tx.job.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
    appendJobs,
  );

  const appendKeywordHits = async (rows: Prisma.KeywordHitGetPayload<object>[]) => {
    sheets.KeywordHits.append(rows.map((row) => [row.articleId, row.keywordId, dateCell(row.createdAt)]));
    await checkpoint('KeywordHits', `已写入 ${sheets.KeywordHits.count} 条关键词命中关系`);
  };
  const keywordHitPage = (baseWhere: Prisma.KeywordHitWhereInput) => (cursor?: KeywordHitCursor) => tx.keywordHit.findMany({
    where: cursor ? { AND: [baseWhere, { OR: [
      { articleId: { gt: cursor.articleId } },
      { articleId: cursor.articleId, keywordId: { gt: cursor.keywordId } },
    ] }] } : baseWhere,
    orderBy: [{ articleId: 'asc' }, { keywordId: 'asc' }],
    take: EXPORT_BATCH_SIZE,
  });
  if (fullScope) {
    await appendKeywordHitPages(keywordHitPage({ createdAt: { lte: snapshotAt } }), appendKeywordHits);
  } else {
    for (const chunk of splitIds(articleIds)) {
      await appendKeywordHitPages(keywordHitPage({ articleId: { in: chunk }, createdAt: { lte: snapshotAt } }), appendKeywordHits);
    }
  }

  const appendKeywords = async (rows: Prisma.KeywordGetPayload<object>[]) => {
    sheets.Keywords.append(rows.map((row) => [row.id, row.category, row.word, dateCell(row.createdAt)]));
    await checkpoint('Keywords', `已写入 ${sheets.Keywords.count} 个关键词`);
  };
  await appendIdPages(
    (cursor) => tx.keyword.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
    appendKeywords,
  );

  const appendCandidates = async (rows: Prisma.KeywordCandidateGetPayload<object>[]) => {
    sheets.KeywordCandidates.append(rows.map((row) => [
      row.id,
      row.phrase,
      row.occurrences,
      jsonText(row.sampleTitles),
      row.status,
      STATUS_LABELS[row.status] ?? row.status,
      dateCell(row.createdAt),
      dateCell(row.updatedAt),
    ]));
    await checkpoint('KeywordCandidates', `已写入 ${sheets.KeywordCandidates.count} 个候选关键词`);
  };
  await appendIdPages(
    (cursor) => tx.keywordCandidate.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
    appendCandidates,
  );

  const appendSuggestions = async (rows: Prisma.TuningSuggestionGetPayload<object>[]) => {
    sheets.TuningSuggestions.append(rows.map((row) => [
      row.id,
      row.kind,
      row.title,
      row.detail,
      redactJson(row.payload),
      row.status,
      STATUS_LABELS[row.status] ?? row.status,
      dateCell(row.createdAt),
      dateCell(row.appliedAt),
    ]));
    await checkpoint('TuningSuggestions', `已写入 ${sheets.TuningSuggestions.count} 条调优建议`);
  };
  await appendIdPages(
    (cursor) => tx.tuningSuggestion.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
    appendSuggestions,
  );

  const appendRetryAudits = async (rows: Prisma.DiscardedRetryAuditGetPayload<object>[]) => {
    sheets.DiscardedRetryAudits.append(rows.map((row) => [
      row.id,
      row.discardedId,
      row.sourceId,
      row.title,
      safeUrl(row.url),
      row.reason,
      redactJson(row.detail),
      row.winnerArticleId ?? '',
      dateCell(row.publishedAt),
      row.action,
      row.articleId ?? '',
      dateCell(row.createdAt),
    ]));
    await checkpoint('DiscardedRetryAudits', `已写入 ${sheets.DiscardedRetryAudits.count} 条重试审计`);
  };
  if (filter.includeDiscarded) {
    if (fullScope) {
      await appendIdPages(
        (cursor) => tx.discardedRetryAudit.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
        appendRetryAudits,
      );
    } else {
      await appendByIdChunksPaged(
        discardedIds,
        (chunk, cursor) => tx.discardedRetryAudit.findMany({ where: { discardedId: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
        appendRetryAudits,
      );
    }
  }

  const appendDeliveries = async (rows: Prisma.PushDeliveryGetPayload<object>[]) => {
    sheets.PushDeliveries.append(rows.map((row) => [
      row.id,
      row.eventId,
      row.targetId,
      row.representativeArticleId ?? '',
      row.contentVersion,
      row.mode,
      row.status,
      STATUS_LABELS[row.status] ?? row.status,
      row.idempotencyKey,
      row.attempt,
      redactSensitiveText(row.lastError),
      row.leaseOwner,
      dateCell(row.leaseExpiresAt),
      dateCell(row.createdAt),
      dateCell(row.updatedAt),
      dateCell(row.sentAt),
      dateCell(row.completedAt),
    ]));
    rows.forEach((row) => targetIds.add(row.targetId));
    await checkpoint('PushDeliveries', `已写入 ${sheets.PushDeliveries.count} 条推送投递`);
  };
  if (fullScope) {
    await appendIdPages(
      (cursor) => tx.pushDelivery.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      appendDeliveries,
    );
  } else {
    await appendByIdChunksPaged(
      eventIds,
      (chunk, cursor) => tx.pushDelivery.findMany({ where: { eventId: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      appendDeliveries,
    );
  }

  const appendPushLogs = async (rows: Prisma.PushLogGetPayload<object>[]) => {
    sheets.PushLogs.append(rows.map((row) => [
      row.id,
      row.eventId,
      row.representativeArticleId ?? '',
      row.targetId ?? '',
      row.status,
      STATUS_LABELS[row.status] ?? row.status,
      redactSensitiveText(row.errorMessage),
      row.retryCount,
      redactSensitiveText(row.webhookRemark),
      dateCell(row.createdAt),
    ]));
    rows.forEach((row) => { if (row.targetId) targetIds.add(row.targetId); });
    await checkpoint('PushLogs', `已写入 ${sheets.PushLogs.count} 条推送日志`);
  };
  if (fullScope) {
    await appendIdPages(
      (cursor) => tx.pushLog.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      appendPushLogs,
    );
  } else {
    await appendByIdChunksPaged(
      eventIds,
      (chunk, cursor) => tx.pushLog.findMany({ where: { eventId: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      appendPushLogs,
    );
  }

  const appendTargets = async (rows: Prisma.PushTargetGetPayload<object>[]) => {
    sheets.PushTargets.append(rows.map((row) => [row.id, row.name, row.urlHash, row.enabled, dateCell(row.createdAt), dateCell(row.updatedAt)]));
    await checkpoint('PushTargets', `已写入 ${sheets.PushTargets.count} 个推送目标`);
  };
  if (fullScope) {
    await appendIdPages(
      (cursor) => tx.pushTarget.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      appendTargets,
    );
  } else {
    await appendByIdChunksPaged(
      targetIds,
      (chunk, cursor) => tx.pushTarget.findMany({ where: { id: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' }, take: EXPORT_BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }),
      appendTargets,
    );
  }

  const appendInteractions = async (rows: Prisma.EventInteractionDailyGetPayload<object>[]) => {
    sheets.EventInteractionDaily.append(rows.map((row) => [
      row.eventId,
      row.sourceId,
      row.dateKey,
      row.viewCount,
      row.originalClickCount,
      dateCell(row.createdAt),
      dateCell(row.updatedAt),
    ]));
    await checkpoint('EventInteractionDaily', `已写入 ${sheets.EventInteractionDaily.count} 条互动统计`);
  };
  const interactionPage = (baseWhere: Prisma.EventInteractionDailyWhereInput) => (cursor?: InteractionCursor) => tx.eventInteractionDaily.findMany({
    where: cursor ? { AND: [baseWhere, { OR: [
      { eventId: { gt: cursor.eventId } },
      { eventId: cursor.eventId, sourceId: { gt: cursor.sourceId } },
      { eventId: cursor.eventId, sourceId: cursor.sourceId, dateKey: { gt: cursor.dateKey } },
    ] }] } : baseWhere,
    orderBy: [{ eventId: 'asc' }, { sourceId: 'asc' }, { dateKey: 'asc' }],
    take: EXPORT_BATCH_SIZE,
  });
  if (fullScope) {
    await appendInteractionPages(interactionPage({ createdAt: { lte: snapshotAt } }), appendInteractions);
  } else {
    for (const chunk of splitIds(eventIds)) {
      await appendInteractionPages(interactionPage({ eventId: { in: chunk }, createdAt: { lte: snapshotAt } }), appendInteractions);
    }
  }

  const exportCompletedAt = new Date();
  const metadataRows: SheetRow[] = [
    ['exportJobId', options.exportJobId],
    ['exportFormatVersion', EXPORT_FORMAT_VERSION],
    ['applicationVersion', options.applicationVersion ?? process.env.npm_package_version ?? 'unknown'],
    ['exportStartedAt', options.exportStartedAt ?? snapshotAt],
    ['exportStartedAtIso', (options.exportStartedAt ?? snapshotAt).toISOString()],
    ['exportCompletedAt', exportCompletedAt],
    ['exportCompletedAtIso', exportCompletedAt.toISOString()],
    ['snapshotAt', snapshotAt],
    ['snapshotAtIso', snapshotAt.toISOString()],
    ['timezone', 'Asia/Shanghai'],
    ['filter', JSON.stringify(filter)],
    ['articleCount', articleTotal],
    ['discardedItemCount', discardedTotal],
  ];
  const counts = Object.fromEntries(Object.entries(sheets).map(([name, builder]) => [name, builder.count]));
  const exportMetaCount = metadataRows.length + 3;
  const errorSummary = Object.fromEntries([...Object.keys(counts), 'ExportMeta'].map((name) => [name, 0]));
  metadataRows.push(
    ['errorCount', 0],
    ['errorSummary', JSON.stringify(errorSummary)],
    ['countSummary', JSON.stringify({ ...counts, ExportMeta: exportMetaCount })],
  );
  sheets.ExportMeta.append(metadataRows);
  await onProgress?.({ total: progressTotal, done: progressTotal, sheet: 'ExportMeta', label: '导出元数据已写入，正在生成 Excel 文件' });

  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer', cellDates: true, compression: true }) as Buffer;
  return { buffer, counts: { ...counts, ExportMeta: sheets.ExportMeta.count }, mainRecordTotal, progressTotal };
}
