import type { Prisma, PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';
import { EXPORT_FORMAT_VERSION, type ExportFilter } from '@/contracts/data-export';
import { projectArticleSteps, type ArticleStepInput } from '@/lib/article-pipeline-status';

export const EXPORT_BATCH_SIZE = 250;

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

interface SheetBuilder {
  append(rows: SheetRow[]): void;
  count: number;
  sheetNames: string[];
}

const MAX_EXCEL_CELL_TEXT_LENGTH = 32_767;
const EXCEL_TEXT_TRUNCATION_SUFFIX = '...[超过 Excel 单元格上限，已截断]';
const EXCEL_DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss';
const CHINA_STANDARD_TIME_OFFSET_HOURS = 8;
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MAX_EXCEL_DATA_ROWS_PER_SHEET = 1_048_575;
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

const SHEET_DISPLAY_NAMES: Record<string, string> = {
  ExportMeta: '导出元数据',
  Sources: '数据源',
  Articles: '文章数据',
  DiscardedItems: '未入库条目',
  Keywords: '关键词',
  KeywordCandidates: '候选关键词',
  FetchLogs: '抓取日志 ID',
  PushLogs: '推送日志',
};

const HEADER_LABELS: Record<string, string> = {
  key: '字段',
  value: '值',
  articleId: '文章 ID',
  sourceId: '来源 ID',
  sourceName: '来源名称',
  sourceType: '来源类型',
  sourceEnabled: '来源是否启用',
  sourcePublicEnabled: '来源是否公开启用',
  sourceStatus: '来源健康状态（原值）',
  sourceStatusLabel: '来源健康状态说明',
  url: '链接',
  title: '标题',
  originalSource: '原始来源',
  contentHash: '内容哈希',
  rawContentLength: '原始抓取内容长度（含 HTML）',
  cleanContentLength: '清洗后保留文本长度',
  articleBodyLength: '提取正文 HTML 长度（含标签）',
  searchIndexUpdatedAt: '全文搜索索引更新时间',
  eventId: '事件 ID（Event ID）',
  eventClusterReviewStatus: '事件聚类复核状态（原值）',
  eventClusterReviewStatusLabel: '事件聚类复核状态说明',
  eventPublicStatus: '事件公开状态（原值）',
  eventPublicStatusLabel: '事件公开状态说明',
  eventRepresentativeArticleId: '事件代表文章 ID',
  eventRepresentativeManual: '事件代表文章选择方式',
  eventArticleCount: '事件文章数量',
  eventMergedIntoId: '事件合并目标 ID',
  clusterStatus: '聚类状态（原值）',
  clusterStatusLabel: '聚类状态说明',
  clusteredAt: '聚类时间',
  clusterError: '聚类错误',
  clusterRetryCount: '聚类重试次数',
  nextClusterRetryAt: '下次聚类重试时间',
  eventSubjects: '事件主体',
  eventAction: '事件动作',
  eventObject: '事件对象',
  eventKey: '事件标识',
  eventKeyConfidence: '事件标识置信度',
  fetchStatus: '抓取状态（原值）',
  fetchStatusLabel: '抓取状态说明',
  fetchError: '抓取错误',
  fetchRetryCount: '抓取重试次数',
  nextFetchRetryAt: '下次抓取重试时间',
  technicalIgnoredAt: '技术忽略时间',
  processingConclusion: '当前处理结论',
  needsManualAction: '是否需要人工处理',
  processingBlockingReason: '处理阻断原因',
  relevance: '相关度',
  summary: '摘要',
  brand: '品牌/主体',
  category: '内容类别',
  keyPoints: '关键要点',
  score: '综合评分',
  keywordMatched: '是否命中关键词',
  keywordHitIds: '命中关键词 ID',
  matchedKeywords: '实际命中关键词',
  eventScore: '事件评分',
  contentScore: '内容评分',
  rawScore: '原始评分',
  adProbability: '软文概率',
  aiConfidence: 'AI 置信度',
  scorePolicyVersion: '评分策略版本',
  aiModel: 'AI 模型',
  aiProvider: 'AI 服务商',
  promptHash: '提示词哈希',
  scorePolicySnapshot: '评分策略快照（原始 JSON）',
  promptVersion: '提示词版本',
  aiStatus: 'AI 状态（原值）',
  aiStatusLabel: 'AI 状态说明',
  aiError: 'AI 错误',
  aiSnapshot: 'AI 分析快照（原始 JSON）',
  manualOverrides: '人工修正（原始 JSON）',
  manualCorrectedAt: '人工修正时间',
  skipReason: '跳过原因',
  aiRetryCount: 'AI 重试次数',
  nextAiRetryAt: '下次 AI 重试时间',
  isAd: '是否软文',
  publicOverride: '公开状态覆盖方式',
  publicStatus: '公开状态（原值）',
  publicStatusLabel: '公开状态说明',
  publicPublishedAt: '公开时间',
  publicRevokedAt: '撤回时间',
  publicPublicationReason: '公开判定原因',
  publicPublicationEvaluatedAt: '公开判定时间',
  publicContentUpdatedAt: '公开内容更新时间',
  viewCount: '浏览次数',
  originalClickCount: '原文点击次数',
  publishedAt: '发布时间',
  createdAt: '创建时间',
  updatedAt: '更新时间',
  isRepresentative: '是否代表文章',
  representativeEventId: '代表事件 ID',
  eventStatus: '事件状态（原值）',
  eventStatusLabel: '事件状态说明',
  eventPushedAt: '事件推送时间',
  status: '状态（原值）',
  statusLabel: '状态说明',
  name: '名称',
  type: '类型',
  parserConfig: '解析配置（已脱敏 JSON）',
  enabled: '是否启用',
  publicEnabled: '是否公开启用',
  consecutiveFailures: '连续失败次数',
  circuitBreakerUntil: '熔断截止时间',
  lastFetchedAt: '最近抓取时间',
  deletedAt: '删除时间',
  fetchLogId: '抓取日志 ID',
  errorMessage: '错误信息',
  itemsFound: '发现条数',
  representativeArticleId: '代表文章 ID',
  targetId: '推送目标 ID',
  pushLogId: '推送日志 ID',
  retryCount: '重试次数',
  webhookRemark: '推送备注',
  keywordId: '关键词 ID',
  word: '关键词',
  candidateId: '候选词 ID',
  phrase: '候选短语',
  occurrences: '出现次数',
  sampleTitles: '示例标题',
  detail: '详情/说明',
  discardedId: '未入库条目 ID',
  reason: '拦截/去重原因',
  winnerArticleId: '命中文章 ID',
};

const DATE_FIELD_LABELS: Record<ExportFilter['dateField'], string> = {
  createdAt: '创建时间',
  publishedAt: '发布时间',
  updatedAt: '更新时间',
};

function displaySheetName(name: string): string {
  return SHEET_DISPLAY_NAMES[name] ?? name;
}

function localizedHeaders(headers: readonly string[]): string[] {
  return headers.map((header) => HEADER_LABELS[header] ?? `字段（${header}）`);
}

function displayFilterValue(value: string): string {
  return STATUS_LABELS[value] ? `${STATUS_LABELS[value]}（${value}）` : value;
}

function formatExportFilter(filter: ExportFilter): string {
  return JSON.stringify({
    日期字段: DATE_FIELD_LABELS[filter.dateField],
    开始时间: filter.from || '不限',
    结束时间: filter.to ? `${filter.to}（不含）` : '不限',
    '来源 ID': filter.sourceIds.length > 0 ? filter.sourceIds : '全部',
    抓取状态: filter.fetchStatuses.length > 0 ? filter.fetchStatuses.map(displayFilterValue) : '全部',
    'AI 状态': filter.aiStatuses.length > 0 ? filter.aiStatuses.map(displayFilterValue) : '全部',
    聚类状态: filter.clusterStatuses.length > 0 ? filter.clusterStatuses.map(displayFilterValue) : '全部',
    公开状态: filter.publicStatuses.length > 0 ? filter.publicStatuses.map(displayFilterValue) : '全部',
    是否代表文章: filter.representative === 'all' ? '全部' : filter.representative === 'yes' ? '是' : '否',
    是否已推送: filter.pushed === 'all' ? '全部' : filter.pushed === 'yes' ? '是' : '否',
    '事件 ID': filter.eventId || '全部',
    是否包含未入库条目: filter.includeDiscarded ? '是' : '否',
  });
}

const ARTICLE_HEADERS = [
  'articleId', 'sourceId', 'sourceName', 'sourceType', 'sourceEnabled', 'sourcePublicEnabled', 'sourceStatus', 'sourceStatusLabel',
  'url',
  // 全文搜索索引的组成顺序：标题、摘要、品牌/主体、事件标识、清洗后正文。
  // 前四项直接复用 Article 已有业务字段；当前精简白名单保留清洗后正文长度和索引更新时间。
  'title', 'summary', 'brand', 'eventKey', 'searchIndexUpdatedAt',
  'originalSource', 'contentHash',
  'rawContentLength', 'articleBodyLength', 'cleanContentLength',
  'eventId', 'eventClusterReviewStatus', 'eventClusterReviewStatusLabel', 'eventPublicStatus', 'eventPublicStatusLabel',
  'eventRepresentativeArticleId', 'eventRepresentativeManual', 'eventArticleCount', 'eventMergedIntoId',
  'clusterStatus', 'clusterStatusLabel', 'clusteredAt', 'clusterError', 'clusterRetryCount', 'nextClusterRetryAt',
  'eventSubjects', 'eventAction', 'eventObject', 'eventKeyConfidence',
  'fetchStatus', 'fetchStatusLabel', 'fetchError', 'fetchRetryCount', 'nextFetchRetryAt', 'technicalIgnoredAt',
  'processingConclusion', 'needsManualAction', 'processingBlockingReason',
  'relevance', 'category', 'keyPoints', 'rawScore', 'score', 'keywordMatched', 'keywordHitIds', 'matchedKeywords',
  'eventScore', 'contentScore', 'adProbability', 'aiConfidence',
  'scorePolicyVersion', 'aiModel', 'aiProvider', 'promptHash', 'scorePolicySnapshot',
  'promptVersion', 'aiStatus', 'aiStatusLabel', 'aiError', 'aiSnapshot', 'manualOverrides', 'manualCorrectedAt',
  'skipReason', 'aiRetryCount', 'nextAiRetryAt', 'isAd',
  'publicOverride', 'publicStatus', 'publicStatusLabel', 'publicPublishedAt', 'publicRevokedAt',
  'publicPublicationReason', 'publicPublicationEvaluatedAt', 'publicContentUpdatedAt',
  'viewCount', 'originalClickCount', 'publishedAt', 'createdAt', 'updatedAt',
  'isRepresentative', 'representativeEventId', 'eventStatus', 'eventStatusLabel', 'eventPushedAt',
] as const;

const SOURCE_HEADERS = [
  'sourceId', 'name', 'type', 'url', 'parserConfig', 'enabled', 'publicEnabled', 'status', 'statusLabel',
  'consecutiveFailures', 'circuitBreakerUntil', 'lastFetchedAt', 'createdAt', 'updatedAt', 'deletedAt',
] as const;
const FETCH_LOG_HEADERS = ['fetchLogId', 'sourceId', 'status', 'statusLabel', 'errorMessage', 'itemsFound', 'createdAt'] as const;
const PUSH_LOG_HEADERS = [
  'pushLogId', 'eventId', 'representativeArticleId', 'targetId', 'status', 'statusLabel', 'errorMessage',
  'retryCount', 'webhookRemark', 'createdAt',
] as const;
const KEYWORD_HEADERS = ['keywordId', 'category', 'word', 'createdAt'] as const;
const KEYWORD_CANDIDATE_HEADERS = ['candidateId', 'phrase', 'occurrences', 'sampleTitles', 'status', 'statusLabel', 'createdAt', 'updatedAt'] as const;
const DISCARDED_HEADERS = [
  'discardedId', 'sourceId', 'title', 'url', 'reason', 'detail', 'winnerArticleId', 'publishedAt', 'createdAt',
] as const;

function dateCell(value: Date | null | undefined): Date | '' {
  return value instanceof Date ? value : '';
}

function excelDateSerial(value: Date): number {
  const chinaStandardTime = value.getTime() + CHINA_STANDARD_TIME_OFFSET_HOURS * 60 * 60 * 1000;
  return (chinaStandardTime - EXCEL_EPOCH_UTC) / (24 * 60 * 60 * 1000);
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

function fitExcelCellText(value: string): string {
  if (value.length <= MAX_EXCEL_CELL_TEXT_LENGTH) return value;
  return `${value.slice(0, MAX_EXCEL_CELL_TEXT_LENGTH - EXCEL_TEXT_TRUNCATION_SUFFIX.length)}${EXCEL_TEXT_TRUNCATION_SUFFIX}`;
}

function createSheetBuilder(
  workbook: XLSX.WorkBook,
  name: string,
  headers: readonly string[],
  widths: number[] = [],
): SheetBuilder {
  const sheetNames: string[] = [];
  let sheet = XLSX.utils.aoa_to_sheet([[...headers]]);
  let sheetRowCount = 0;
  const createSheet = (part: number) => {
    const sheetName = part === 1 ? name : `${name}_${part}`;
    sheet = XLSX.utils.aoa_to_sheet([[...headers]]);
    if (widths.length > 0) sheet['!cols'] = widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
    sheetNames.push(sheetName);
    sheetRowCount = 0;
  };
  createSheet(1);
  let count = 0;

  return {
    get count() {
      return count;
    },
    get sheetNames() {
      return sheetNames;
    },
    append(rows: SheetRow[]) {
      if (rows.length === 0) return;
      const normalizedRows = rows.map((row) => row.map((value) =>
        typeof value === 'string' ? fitExcelCellText(value) : value,
      ));
      for (let offset = 0; offset < normalizedRows.length;) {
        if (sheetRowCount >= MAX_EXCEL_DATA_ROWS_PER_SHEET) createSheet(sheetNames.length + 1);
        const capacity = MAX_EXCEL_DATA_ROWS_PER_SHEET - sheetRowCount;
        const page = normalizedRows.slice(offset, offset + capacity);
        const startRow = sheetRowCount + 1;
        XLSX.utils.sheet_add_aoa(sheet, page, { origin: { r: startRow, c: 0 } });
        page.forEach((row, rowIndex) => {
          row.forEach((value, columnIndex) => {
            const address = XLSX.utils.encode_cell({ r: startRow + rowIndex, c: columnIndex });
            const cell = (sheet[address] ?? {}) as { t?: string; v?: unknown; f?: string; z?: string };
            if (typeof value === 'string' || value === null || value === undefined) {
              cell.t = 's';
              cell.v = value ?? '';
              delete cell.f;
            } else if (value instanceof Date) {
              cell.t = 'n';
              cell.v = excelDateSerial(value);
              cell.z = EXCEL_DATE_FORMAT;
              delete cell.f;
            }
            sheet[address] = cell as XLSX.CellObject;
          });
        });
        sheetRowCount += page.length;
        count += page.length;
        offset += page.length;
      }
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

function parseDate(value: string): Date | undefined {
  if (!value) return undefined;
  const text = value.trim();
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const candidate = hasTimezone
    ? text
    : /^\d{4}-\d{2}-\d{2}$/.test(text)
      ? `${text}T00:00:00+08:00`
      : `${text}+08:00`;
  const date = new Date(candidate);
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

async function getLatestPushedEventIds(tx: ExportDb, snapshotAt: Date): Promise<Set<string>> {
  const deliveryWhere: Prisma.PushDeliveryWhereInput = {
    createdAt: { lte: snapshotAt },
    updatedAt: { lte: snapshotAt },
  };
  if (typeof tx.pushDelivery.groupBy !== 'function') {
    const rows = await tx.pushDelivery.findMany({
      where: deliveryWhere,
      orderBy: [{ eventId: 'asc' }, { targetId: 'asc' }, { updatedAt: 'desc' }],
      select: { eventId: true, targetId: true, status: true },
    });
    const latest = new Map<string, string>();
    for (const row of rows) {
      const key = `${row.eventId}:${row.targetId}`;
      if (!latest.has(key)) latest.set(key, row.status);
    }
    return new Set([...latest.entries()].filter(([, status]) => status === 'succeeded').map(([key]) => key.split(':')[0]));
  }
  const latestKeys = await tx.pushDelivery.groupBy({
    by: ['eventId', 'targetId'],
    where: deliveryWhere,
    _max: { updatedAt: true },
  });
  const latestRows: Array<{ eventId: string; status: string }> = [];
  for (let index = 0; index < latestKeys.length; index += 500) {
    const chunk = latestKeys.slice(index, index + 500);
    if (chunk.length === 0) continue;
    const rows = await tx.pushDelivery.findMany({
      where: {
        OR: chunk.flatMap((key) => key._max.updatedAt
          ? [{ eventId: key.eventId, targetId: key.targetId, updatedAt: key._max.updatedAt }]
          : []),
      },
      select: { eventId: true, targetId: true, status: true, updatedAt: true },
    });
    latestRows.push(...rows);
  }
  return new Set(latestRows.filter((row) => row.status === 'succeeded').map((row) => row.eventId));
}

function buildArticleWhere(
  filter: ExportFilter,
  snapshotAt: Date,
  pushedEventIds?: Set<string>,
): Prisma.ArticleWhereInput {
  const conditions: Prisma.ArticleWhereInput[] = [{ createdAt: { lte: snapshotAt } }];
  if (filter.sourceIds.length > 0) conditions.push({ sourceId: { in: filter.sourceIds } });
  if (filter.fetchStatuses.length > 0) conditions.push({ fetchStatus: { in: filter.fetchStatuses } });
  if (filter.aiStatuses.length > 0) conditions.push({ aiStatus: { in: filter.aiStatuses } });
  if (filter.clusterStatuses.length > 0) conditions.push({ clusterStatus: { in: filter.clusterStatuses } });
  if (filter.publicStatuses.length > 0) conditions.push({ publicStatus: { in: filter.publicStatuses } });
  if (filter.eventId) conditions.push({ eventId: filter.eventId });
  if (filter.representative === 'yes') conditions.push({ representedEvent: { isNot: null } });
  if (filter.representative === 'no') conditions.push({ representedEvent: { is: null } });
  if (filter.pushed === 'yes') {
    conditions.push(pushedEventIds ? { eventId: { in: [...pushedEventIds] } } : { event: { is: { pushedAt: { not: null } } } });
  }
  if (filter.pushed === 'no') {
    conditions.push(pushedEventIds
      ? { OR: [{ eventId: null }, { eventId: { notIn: [...pushedEventIds] } }] }
      : { OR: [{ event: { is: null } }, { event: { is: { pushedAt: null } } }] });
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

interface ArticleExportDecisionInput extends Pick<ArticleStepInput, 'fetchStatus' | 'clusterStatus' | 'aiStatus' | 'score' | 'relevance'> {
  nextFetchRetryAt: Date | null;
  nextAiRetryAt: Date | null;
  nextClusterRetryAt: Date | null;
  technicalIgnoredAt: Date | null;
  event: {
    clusterReviewStatus: string;
    publicStatus: string;
    pushedAt: Date | null;
  } | null;
}

interface ArticleExportDecision {
  conclusion: string;
  needsManualAction: boolean;
  blockingReason: string;
}

function deriveArticleExportDecision(article: ArticleExportDecisionInput): ArticleExportDecision {
  const projection = projectArticleSteps({
    fetchStatus: article.fetchStatus,
    clusterStatus: article.clusterStatus,
    aiStatus: article.aiStatus,
    score: article.score,
    relevance: article.relevance,
    eventPushedAt: article.event?.pushedAt ?? null,
    eventNextRetryAt: null,
    pushApplicable: false,
  }, {
    pushMode: 'off',
    minScore: 0,
    minRelevance: 0,
    now: new Date(0),
  });
  const reasons: string[] = [];
  let needsManualAction = false;

  if (article.technicalIgnoredAt) {
    reasons.push('已人工忽略技术异常');
    needsManualAction = true;
  }
  if (projection.process === 'pending') {
    reasons.push('等待正文抓取');
  } else if (projection.process === 'failed') {
    reasons.push(article.nextFetchRetryAt ? '正文抓取失败，等待自动重试' : '正文抓取失败，需要人工处理');
    needsManualAction ||= !article.nextFetchRetryAt;
  }
  if (projection.ai === 'pending') {
    reasons.push('等待 AI 分析');
  } else if (projection.ai === 'failed') {
    reasons.push(article.nextAiRetryAt ? 'AI 分析失败，等待自动重试' : 'AI 分析失败，需要人工处理');
    needsManualAction ||= !article.nextAiRetryAt;
  }
  if (projection.cluster === 'pending') {
    reasons.push('等待事件聚类');
  } else if (projection.cluster === 'failed') {
    reasons.push(article.nextClusterRetryAt ? '事件聚类失败，等待自动重试' : '事件聚类失败，需要人工处理');
    needsManualAction ||= !article.nextClusterRetryAt;
  }

  const needsEventReview = article.clusterStatus === 'needs_review'
    || article.event?.clusterReviewStatus === 'pending';
  if (needsEventReview) {
    reasons.push('事件聚类待人工复核');
    needsManualAction = true;
  }

  const missingEvent = projection.cluster === 'done'
    && article.clusterStatus === 'clustered'
    && !article.event;
  if (missingEvent) {
    reasons.push('已聚类但尚未关联事件');
    needsManualAction = true;
  }

  let conclusion = '处理完成，待公开/推送';
  if (article.technicalIgnoredAt) {
    conclusion = '已忽略技术异常';
  } else if (projection.process === 'pending') {
    conclusion = '待抓取正文';
  } else if (projection.process === 'failed') {
    conclusion = article.nextFetchRetryAt ? '正文抓取失败，等待自动重试' : '正文抓取失败，需要人工处理';
  } else if (projection.ai === 'pending') {
    conclusion = '待 AI 分析';
  } else if (projection.ai === 'failed') {
    conclusion = article.nextAiRetryAt ? 'AI 分析失败，等待自动重试' : 'AI 分析失败，需要人工处理';
  } else if (projection.ai === 'skipped') {
    conclusion = 'AI 已跳过';
  } else if (projection.cluster === 'pending') {
    conclusion = '待事件聚类';
  } else if (projection.cluster === 'failed') {
    conclusion = article.nextClusterRetryAt ? '事件聚类失败，等待自动重试' : '事件聚类失败，需要人工处理';
  } else if (needsEventReview) {
    conclusion = '待事件复核';
  } else if (missingEvent) {
    conclusion = '待关联事件';
  } else if (article.event?.publicStatus === 'published' && article.event.pushedAt) {
    conclusion = '已公开并已推送';
  } else if (article.event?.publicStatus === 'published') {
    conclusion = '已公开';
  } else if (article.event?.pushedAt) {
    conclusion = '已推送';
  }

  return {
    conclusion,
    needsManualAction,
    blockingReason: reasons.join('；'),
  };
}

function makeArticleRow(article: Prisma.ArticleGetPayload<{
  include: {
    source: true;
    searchIndex: true;
    event: { select: {
      id: true;
      status: true;
      clusterReviewStatus: true;
      publicStatus: true;
      representativeArticleId: true;
      representativeManual: true;
      articleCount: true;
      mergedIntoId: true;
      pushedAt: true;
    } };
    representedEvent: { select: { id: true; representativeManual: true } };
    keywordHits: { include: { keyword: true } };
  };
}>): SheetRow {
  const decision = deriveArticleExportDecision({
    fetchStatus: article.fetchStatus,
    clusterStatus: article.clusterStatus,
    aiStatus: article.aiStatus,
    score: article.score,
    relevance: article.relevance,
    nextFetchRetryAt: article.nextFetchRetryAt,
    nextAiRetryAt: article.nextAiRetryAt,
    nextClusterRetryAt: article.nextClusterRetryAt,
    technicalIgnoredAt: article.technicalIgnoredAt,
    event: article.event,
  });
  const keywordHitIds = article.keywordHits.map((hit) => hit.keywordId);
  const matchedKeywords = article.keywordHits.map((hit) => hit.keyword.word);

  return [
    article.id,
    article.sourceId,
    article.source.name,
    article.source.type,
    article.source.enabled,
    article.source.publicEnabled,
    article.source.status,
    STATUS_LABELS[article.source.status] ?? article.source.status,
    safeUrl(article.url),
    article.title,
    article.summary,
    article.brand,
    article.eventKey,
    dateCell(article.searchIndex?.updatedAt),
    article.originalSource ?? '',
    article.contentHash,
    article.rawContent.length,
    article.articleBody.length,
    article.cleanContent.length,
    article.eventId ?? '',
    article.event?.clusterReviewStatus ?? '',
    STATUS_LABELS[article.event?.clusterReviewStatus ?? ''] ?? article.event?.clusterReviewStatus ?? '',
    article.event?.publicStatus ?? '',
    STATUS_LABELS[article.event?.publicStatus ?? ''] ?? article.event?.publicStatus ?? '',
    article.event?.representativeArticleId ?? '',
    article.event ? (article.event.representativeManual ? '人工选择' : '自动选择') : '',
    article.event?.articleCount ?? '',
    article.event?.mergedIntoId ?? '',
    article.clusterStatus,
    STATUS_LABELS[article.clusterStatus] ?? article.clusterStatus,
    dateCell(article.clusteredAt),
    redactSensitiveText(article.clusterError ?? ''),
    article.clusterRetryCount,
    dateCell(article.nextClusterRetryAt),
    jsonText(article.eventSubjects),
    article.eventAction,
    article.eventObject,
    article.eventKeyConfidence,
    article.fetchStatus,
    STATUS_LABELS[article.fetchStatus] ?? article.fetchStatus,
    redactSensitiveText(article.fetchError ?? ''),
    article.fetchRetryCount,
    dateCell(article.nextFetchRetryAt),
    dateCell(article.technicalIgnoredAt),
    decision.conclusion,
    decision.needsManualAction,
    decision.blockingReason,
    article.relevance,
    article.category,
    jsonText(article.keyPoints),
    article.rawScore,
    article.score,
    article.keywordMatched,
    JSON.stringify(keywordHitIds),
    matchedKeywords.join('、'),
    article.eventScore,
    article.contentScore,
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
    sheets[name] = createSheetBuilder(
      workbook,
      displaySheetName(name),
      localizedHeaders(headers),
      widths,
    );
  };

  add('ExportMeta', ['key', 'value'], [30, 80]);
  add('Sources', SOURCE_HEADERS, [24, 28, 16, 48, 80, 12, 14, 18, 16, 24, 24, 24, 24, 24]);
  add('Articles', ARTICLE_HEADERS, [24, 18, 24, 16, 14, 18, 18, 18, 48, 48, 24, 24, 16, 16, 16, 48, 24]);
  add('DiscardedItems', DISCARDED_HEADERS, [24, 24, 48, 48, 24, 80, 24, 24, 24]);
  add('Keywords', KEYWORD_HEADERS, [24, 16, 48, 24]);
  add('KeywordCandidates', KEYWORD_CANDIDATE_HEADERS, [24, 48, 16, 80, 16, 24, 24]);
  add('FetchLogs', FETCH_LOG_HEADERS, [24, 24, 16, 80, 12, 24]);
  add('PushLogs', PUSH_LOG_HEADERS, [24, 24, 24, 24, 16, 80, 12, 32, 24]);

  const eventIds = new Set<string>();
  const sourceIds = new Set<string>();
  const pushedEventIds = filter.pushed === 'all' ? undefined : await getLatestPushedEventIds(tx, snapshotAt);
  const articleWhere = buildArticleWhere(filter, snapshotAt, pushedEventIds);
  const discardedWhere = buildDiscardedWhere(filter, snapshotAt);
  const fullScope = isUnboundedFilter(filter);
  const articleTotal = await tx.article.count({ where: articleWhere });
  const discardedTotal = filter.includeDiscarded ? await tx.discardedItem.count({ where: discardedWhere }) : 0;
  const mainRecordTotal = articleTotal + discardedTotal;
  const progressTotal = Math.max(1, mainRecordTotal + 1);
  let mainDone = 0;
  const checkpoint = (sheet: string, label: string) => onProgress?.({
    total: progressTotal,
    done: mainDone,
    sheet: displaySheetName(sheet),
    label: label.replace(/\bEvent\b/g, '事件').replace(/\bJob\b/g, '任务'),
  });
  await checkpoint('Articles', `准备导出 ${articleTotal} 篇文章`);

  let articleCursor: string | undefined;
  while (true) {
    const page = await tx.article.findMany({
      where: articleWhere,
      include: {
        source: true,
        searchIndex: true,
        event: { select: {
          id: true,
          status: true,
          clusterReviewStatus: true,
          publicStatus: true,
          representativeArticleId: true,
          representativeManual: true,
          articleCount: true,
          mergedIntoId: true,
          pushedAt: true,
        } },
        representedEvent: { select: { id: true, representativeManual: true } },
        keywordHits: {
          include: { keyword: true },
          orderBy: { keywordId: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
      take: EXPORT_BATCH_SIZE,
      ...(articleCursor ? { skip: 1, cursor: { id: articleCursor } } : {}),
    });
    if (page.length === 0) break;
    sheets.Articles.append(page.map(makeArticleRow));
    for (const article of page) {
      sourceIds.add(article.sourceId);
      if (article.eventId) eventIds.add(article.eventId);
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
        sourceIds.add(item.sourceId);
      }
      mainDone += page.length;
      await checkpoint('DiscardedItems', `已读取 ${mainDone}/${mainRecordTotal} 条主记录`);
      discardedCursor = page[page.length - 1].id;
    }
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

  const exportCompletedAt = new Date();
  const metadataRows: SheetRow[] = [
    ['导出任务 ID', options.exportJobId],
    ['导出格式版本', EXPORT_FORMAT_VERSION],
    ['应用版本', options.applicationVersion ?? process.env.npm_package_version ?? 'unknown'],
    ['导出开始时间', options.exportStartedAt ?? snapshotAt],
    ['导出完成时间', exportCompletedAt],
    ['快照时间', snapshotAt],
    ['时区', 'Asia/Shanghai（中国标准时间）'],
    ['筛选条件', formatExportFilter(filter)],
    ['文章数量', articleTotal],
    ['未入库条目数量', discardedTotal],
  ];
  const counts = Object.fromEntries(Object.entries(sheets).map(([name, builder]) => [displaySheetName(name), builder.count]));
  const exportMetaCount = metadataRows.length + 3;
  const errorSummary = Object.fromEntries(Object.keys(counts).map((name) => [name, 0]));
  metadataRows.push(
    ['错误数量', 0],
    ['错误汇总', JSON.stringify(errorSummary)],
    ['行数汇总', JSON.stringify({ ...counts, [displaySheetName('ExportMeta')]: exportMetaCount })],
  );
  sheets.ExportMeta.append(metadataRows);
  await onProgress?.({
    total: progressTotal,
    done: progressTotal,
    sheet: displaySheetName('ExportMeta'),
    label: '导出元数据已写入，正在生成 Excel 文件',
  });

  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer', cellDates: false, compression: true }) as Buffer;
  return {
    buffer,
    counts: { ...counts, [displaySheetName('ExportMeta')]: sheets.ExportMeta.count },
    mainRecordTotal,
    progressTotal,
  };
}
