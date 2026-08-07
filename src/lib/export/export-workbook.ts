import type { Prisma, PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';
import type { ExportFilter } from '@/contracts/data-export';

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
}

interface SheetBuilder {
  append(rows: SheetRow[]): void;
  count: number;
}

const SENSITIVE_KEY_PATTERN = /(?:api[-_]?key|authorization|cookie|credential|password|secret|signature|token|webhook)/i;
const SENSITIVE_QUERY_KEY_PATTERN = /(?:api[-_]?key|authorization|cookie|credential|password|secret|signature|token|webhook)/i;

const ARTICLE_HEADERS = [
  'articleId', 'sourceId', 'sourceName', 'url', 'title', 'originalSource', 'contentHash',
  'rawContentLength', 'cleanContentLength', 'articleBodyLength', 'searchText',
  'eventId', 'clusterStatus', 'clusteredAt', 'clusterError', 'clusterRetryCount', 'nextClusterRetryAt',
  'eventSubjects', 'eventAction', 'eventObject', 'eventKey', 'eventKeyConfidence',
  'fetchStatus', 'fetchError', 'fetchRetryCount', 'nextFetchRetryAt', 'technicalIgnoredAt',
  'relevance', 'summary', 'brand', 'category', 'keyPoints', 'score', 'keywordMatched',
  'eventScore', 'contentScore', 'rawScore', 'adProbability', 'aiConfidence',
  'scorePolicyVersion', 'aiModel', 'aiProvider', 'promptHash', 'scorePolicySnapshot',
  'promptVersion', 'aiStatus', 'aiError', 'aiSnapshot', 'manualOverrides', 'manualCorrectedAt',
  'skipReason', 'aiRetryCount', 'nextAiRetryAt', 'isAd',
  'publicOverride', 'publicStatus', 'publicPublishedAt', 'publicRevokedAt',
  'publicPublicationReason', 'publicPublicationEvaluatedAt', 'publicContentUpdatedAt',
  'viewCount', 'originalClickCount', 'publishedAt', 'createdAt', 'updatedAt',
  'isRepresentative', 'representativeEventId', 'eventStatus', 'eventPushedAt',
] as const;

const ARTICLE_CONTENT_HEADERS = ['articleId', 'contentType', 'chunkNo', 'chunkTotal', 'contentChunk'] as const;
const EVENT_HEADERS = [
  'eventId', 'status', 'clusterReviewStatus', 'mergedIntoId', 'representativeArticleId',
  'representativeManual', 'firstSeenAt', 'lastSeenAt', 'articleCount', 'publicStatus',
  'publicPublishedAt', 'publicRevokedAt', 'publicDateKey', 'publicSortAt', 'pushedAt',
  'viewCount', 'originalClickCount', 'nextPushRetryAt', 'pushRetryCount', 'createdAt', 'updatedAt',
  'dirtyReason',
] as const;
const ARTICLE_EVENT_HEADERS = [
  'articleId', 'eventId', 'isRepresentative', 'representativeManual', 'eventStatus', 'eventKey',
] as const;
const EVENT_AUDIT_HEADERS = [
  'auditId', 'articleId', 'assignedEventId', 'candidateEventId', 'actor', 'action',
  'decisionSource', 'confidence', 'evidence', 'createdAt',
] as const;
const SOURCE_HEADERS = [
  'sourceId', 'name', 'type', 'url', 'parserConfig', 'enabled', 'publicEnabled', 'status',
  'consecutiveFailures', 'circuitBreakerUntil', 'lastFetchedAt', 'createdAt', 'updatedAt', 'deletedAt',
] as const;
const FETCH_LOG_HEADERS = ['fetchLogId', 'sourceId', 'status', 'errorMessage', 'itemsFound', 'createdAt'] as const;
const JOB_HEADERS = [
  'jobId', 'type', 'status', 'payload', 'result', 'error', 'currentStage', 'progressTotal',
  'progressDone', 'progressErrors', 'currentItemLabel', 'heartbeatAt', 'leaseOwner',
  'leaseExpiresAt', 'attempt', 'maxAttempts', 'idempotencyKey', 'availableAt', 'cancelRequestedAt',
  'createdAt', 'updatedAt', 'startedAt', 'completedAt',
] as const;
const PUSH_TARGET_HEADERS = ['targetId', 'name', 'urlHash', 'enabled', 'createdAt', 'updatedAt'] as const;
const PUSH_DELIVERY_HEADERS = [
  'deliveryId', 'eventId', 'targetId', 'representativeArticleId', 'contentVersion', 'mode',
  'status', 'idempotencyKey', 'attempt', 'lastError', 'leaseOwner', 'leaseExpiresAt',
  'createdAt', 'updatedAt', 'sentAt', 'completedAt',
] as const;
const PUSH_LOG_HEADERS = [
  'pushLogId', 'eventId', 'representativeArticleId', 'targetId', 'status', 'errorMessage',
  'retryCount', 'webhookRemark', 'createdAt',
] as const;
const INTERACTION_HEADERS = [
  'eventId', 'sourceId', 'dateKey', 'viewCount', 'originalClickCount', 'createdAt', 'updatedAt',
] as const;
const KEYWORD_HIT_HEADERS = ['articleId', 'keywordId', 'createdAt'] as const;
const KEYWORD_HEADERS = ['keywordId', 'category', 'word', 'createdAt'] as const;
const KEYWORD_CANDIDATE_HEADERS = ['candidateId', 'phrase', 'occurrences', 'sampleTitles', 'status', 'createdAt', 'updatedAt'] as const;
const TUNING_HEADERS = ['suggestionId', 'kind', 'title', 'detail', 'payload', 'status', 'createdAt', 'appliedAt'] as const;
const DISCARDED_HEADERS = [
  'discardedId', 'sourceId', 'title', 'url', 'reason', 'detail', 'winnerArticleId', 'publishedAt', 'createdAt',
] as const;
const DISCARDED_AUDIT_HEADERS = [
  'auditId', 'discardedId', 'sourceId', 'title', 'url', 'reason', 'detail', 'winnerArticleId',
  'publishedAt', 'action', 'articleId', 'createdAt',
] as const;

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
  return value.replace(
    /((?:api[-_]?key|authorization|cookie|credential|password|secret|signature|token|webhook))\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
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
    return url.toString();
  } catch {
    return redactSensitiveText(value);
  }
}

function readableJsonArray(value: string | null | undefined): string {
  if (!value) return '';
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).join('、') : '';
  } catch {
    return '';
  }
}

function createSheetBuilder(
  workbook: XLSX.WorkBook,
  name: string,
  headers: readonly string[],
  widths: number[] = [],
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
      const startRow = count + 1;
      XLSX.utils.sheet_add_aoa(sheet, rows, { origin: { r: startRow, c: 0 } });
      rows.forEach((row, rowIndex) => {
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

async function appendByIdChunks<T>(
  ids: Set<string>,
  load: (chunk: string[]) => Promise<T[]>,
  append: (rows: T[]) => void,
): Promise<void> {
  for (const chunk of splitIds(ids)) append(await load(chunk));
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
    conditions.push({ publishedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } });
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
    where.publishedAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) };
  } else if (filter.dateField === 'createdAt') {
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
    representedEvent: { select: { id: true } };
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
    article.eventId ?? '',
    article.clusterStatus,
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
    redactSensitiveText(article.aiError ?? ''),
    redactJson(article.aiSnapshot),
    jsonText(article.manualOverrides),
    dateCell(article.manualCorrectedAt),
    redactSensitiveText(article.skipReason ?? ''),
    article.aiRetryCount,
    dateCell(article.nextAiRetryAt),
    article.isAd,
    article.publicOverride,
    article.publicStatus,
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
    event.clusterReviewStatus,
    event.mergedIntoId ?? '',
    event.representativeArticleId ?? '',
    event.representativeManual,
    dateCell(event.firstSeenAt),
    dateCell(event.lastSeenAt),
    event.articleCount,
    event.publicStatus,
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
): Promise<ExportWorkbookResult> {
  const workbook = XLSX.utils.book_new();
  const sheets: Record<string, SheetBuilder> = {};
  const add = (name: string, headers: readonly string[], widths: number[] = []) => {
    sheets[name] = createSheetBuilder(workbook, name, headers, widths);
  };

  add('ExportMeta', ['key', 'value'], [30, 80]);
  add('Articles', ARTICLE_HEADERS, [24, 18, 24, 48, 48, 24, 24, 16, 16, 16, 48]);
  add('ArticleContent', ARTICLE_CONTENT_HEADERS, [24, 18, 12, 12, 100]);
  add('Events', EVENT_HEADERS, [24, 16, 18, 24, 24, 16, 24, 24, 12, 18, 24, 24, 16, 24, 24, 12, 16, 24, 16, 24, 24, 24]);
  add('ArticleEventRelations', ARTICLE_EVENT_HEADERS, [24, 24, 16, 18, 16, 48]);
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
  let mainDone = 0;
  await onProgress?.({ total: mainRecordTotal, done: 0, sheet: 'Articles', label: `准备导出 ${articleTotal} 篇文章` });

  let articleCursor: string | undefined;
  while (true) {
    const page = await tx.article.findMany({
      where: articleWhere,
      include: {
        source: true,
        searchIndex: true,
        event: { select: { id: true, status: true, pushedAt: true } },
        representedEvent: { select: { id: true } },
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
      Boolean(article.representedEvent),
      article.event?.status ?? '',
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
    await onProgress?.({ total: mainRecordTotal, done: mainDone, sheet: 'Articles', label: `已读取 ${mainDone}/${mainRecordTotal} 条主记录` });
    articleCursor = page[page.length - 1].id;
  }

  if (filter.includeDiscarded) {
    let discardedCursor: string | undefined;
    await onProgress?.({ total: mainRecordTotal, done: mainDone, sheet: 'DiscardedItems', label: `准备导出 ${discardedTotal} 条未入库记录` });
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
      await onProgress?.({ total: mainRecordTotal, done: mainDone, sheet: 'DiscardedItems', label: `已读取 ${mainDone}/${mainRecordTotal} 条主记录` });
      discardedCursor = page[page.length - 1].id;
    }
  }

  const eventRows = fullScope
    ? await tx.event.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } })
    : await (async () => {
      const rows: Prisma.EventGetPayload<object>[] = [];
      await appendByIdChunks(eventIds, async (chunk) => tx.event.findMany({ where: { id: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } }), (loaded) => rows.push(...loaded));
      return rows;
    })();
  const dirtyRows = fullScope
    ? await tx.eventDirty.findMany({ where: { createdAt: { lte: snapshotAt } } })
    : await tx.eventDirty.findMany({ where: { eventId: { in: [...eventIds] }, createdAt: { lte: snapshotAt } } });
  const dirtyMap = new Map(dirtyRows.map((row) => [row.eventId, row.reason]));
  for (const event of eventRows) {
    if (event.mergedIntoId) eventIds.add(event.mergedIntoId);
    sheets.Events.append([makeEventRow(event, dirtyMap.get(event.id) ?? '')]);
  }

  await appendByIdChunks(articleIds, async (chunk) => tx.eventClusterAudit.findMany({ where: { articleId: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { createdAt: 'asc' } }), (rows) => {
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
  });

  const sourceRows = fullScope
    ? await tx.source.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } })
    : await (async () => {
      const rows: Prisma.SourceGetPayload<object>[] = [];
      await appendByIdChunks(sourceIds, async (chunk) => tx.source.findMany({ where: { id: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } }), (loaded) => rows.push(...loaded));
      return rows;
    })();
  sheets.Sources.append(sourceRows.map((source) => [
    source.id,
    source.name,
    source.type,
    safeUrl(source.url),
    redactJson(source.parserConfig),
    source.enabled,
    source.publicEnabled,
    source.status,
    source.consecutiveFailures,
    dateCell(source.circuitBreakerUntil),
    dateCell(source.lastFetchedAt),
    dateCell(source.createdAt),
    dateCell(source.updatedAt),
    dateCell(source.deletedAt),
  ]));

  const fetchLogs = fullScope
    ? await tx.fetchLog.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } })
    : await (async () => {
      const rows: Prisma.FetchLogGetPayload<object>[] = [];
      await appendByIdChunks(sourceIds, async (chunk) => tx.fetchLog.findMany({ where: { sourceId: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } }), (loaded) => rows.push(...loaded));
      return rows;
    })();
  sheets.FetchLogs.append(fetchLogs.map((row) => [row.id, row.sourceId, row.status, redactSensitiveText(row.errorMessage), row.itemsFound, dateCell(row.createdAt)]));

  const jobs = await tx.job.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } });
  sheets.Jobs.append(jobs.map((job) => [
    job.id,
    job.type,
    job.status,
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

  const keywordHits = fullScope
    ? await tx.keywordHit.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { createdAt: 'asc' } })
    : await (async () => {
      const rows: Prisma.KeywordHitGetPayload<object>[] = [];
      await appendByIdChunks(articleIds, async (chunk) => tx.keywordHit.findMany({ where: { articleId: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { createdAt: 'asc' } }), (loaded) => rows.push(...loaded));
      return rows;
    })();
  sheets.KeywordHits.append(keywordHits.map((row) => [row.articleId, row.keywordId, dateCell(row.createdAt)]));

  const keywords = await tx.keyword.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } });
  sheets.Keywords.append(keywords.map((row) => [row.id, row.category, row.word, dateCell(row.createdAt)]));
  const candidates = await tx.keywordCandidate.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } });
  sheets.KeywordCandidates.append(candidates.map((row) => [row.id, row.phrase, row.occurrences, jsonText(row.sampleTitles), row.status, dateCell(row.createdAt), dateCell(row.updatedAt)]));
  const suggestions = await tx.tuningSuggestion.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } });
  sheets.TuningSuggestions.append(suggestions.map((row) => [row.id, row.kind, row.title, row.detail, redactJson(row.payload), row.status, dateCell(row.createdAt), dateCell(row.appliedAt)]));

  const retryAudits = !filter.includeDiscarded
    ? []
    : fullScope
      ? await tx.discardedRetryAudit.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } })
      : await tx.discardedRetryAudit.findMany({ where: { sourceId: { in: [...sourceIds] }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } });
  sheets.DiscardedRetryAudits.append(retryAudits.map((row) => [
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

  const deliveries = fullScope
    ? await tx.pushDelivery.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } })
    : await (async () => {
      const rows: Prisma.PushDeliveryGetPayload<object>[] = [];
      await appendByIdChunks(eventIds, async (chunk) => tx.pushDelivery.findMany({ where: { eventId: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } }), (loaded) => rows.push(...loaded));
      return rows;
    })();
  sheets.PushDeliveries.append(deliveries.map((row) => [
    row.id,
    row.eventId,
    row.targetId,
    row.representativeArticleId ?? '',
    row.contentVersion,
    row.mode,
    row.status,
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
  for (const row of deliveries) targetIds.add(row.targetId);

  const pushLogs = fullScope
    ? await tx.pushLog.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } })
    : await (async () => {
      const rows: Prisma.PushLogGetPayload<object>[] = [];
      await appendByIdChunks(eventIds, async (chunk) => tx.pushLog.findMany({ where: { eventId: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } }), (loaded) => rows.push(...loaded));
      return rows;
    })();
  sheets.PushLogs.append(pushLogs.map((row) => [
    row.id,
    row.eventId,
    row.representativeArticleId ?? '',
    row.targetId ?? '',
    row.status,
    redactSensitiveText(row.errorMessage),
    row.retryCount,
    redactSensitiveText(row.webhookRemark),
    dateCell(row.createdAt),
  ]));
  for (const row of pushLogs) if (row.targetId) targetIds.add(row.targetId);

  const targets = fullScope
    ? await tx.pushTarget.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } })
    : await (async () => {
      const rows: Prisma.PushTargetGetPayload<object>[] = [];
      await appendByIdChunks(targetIds, async (chunk) => tx.pushTarget.findMany({ where: { id: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { id: 'asc' } }), (loaded) => rows.push(...loaded));
      return rows;
    })();
  sheets.PushTargets.append(targets.map((row) => [row.id, row.name, row.urlHash, row.enabled, dateCell(row.createdAt), dateCell(row.updatedAt)]));

  const interactions = fullScope
    ? await tx.eventInteractionDaily.findMany({ where: { createdAt: { lte: snapshotAt } }, orderBy: { dateKey: 'asc' } })
    : await (async () => {
      const rows: Prisma.EventInteractionDailyGetPayload<object>[] = [];
      await appendByIdChunks(eventIds, async (chunk) => tx.eventInteractionDaily.findMany({ where: { eventId: { in: chunk }, createdAt: { lte: snapshotAt } }, orderBy: { dateKey: 'asc' } }), (loaded) => rows.push(...loaded));
      return rows;
    })();
  sheets.EventInteractionDaily.append(interactions.map((row) => [
    row.eventId,
    row.sourceId,
    row.dateKey,
    row.viewCount,
    row.originalClickCount,
    dateCell(row.createdAt),
    dateCell(row.updatedAt),
  ]));

  const counts = Object.fromEntries(Object.entries(sheets).map(([name, builder]) => [name, builder.count]));
  sheets.ExportMeta.append([
    ['exportFormatVersion', 1],
    ['snapshotAt', snapshotAt],
    ['timezone', 'Asia/Shanghai'],
    ['filter', JSON.stringify(filter)],
    ['articleCount', articleTotal],
    ['discardedItemCount', discardedTotal],
    ['countSummary', JSON.stringify(counts)],
  ]);

  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer', cellDates: true, compression: true }) as Buffer;
  return { buffer, counts: { ...counts, ExportMeta: sheets.ExportMeta.count }, mainRecordTotal };
}
