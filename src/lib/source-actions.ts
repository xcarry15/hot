import { Prisma } from '@prisma/client';
import { db } from './db';
import { runJob } from './execution';
import { testCrawlSource } from './pipeline/collect';
import { PRESET_SOURCES, getPresetSourceById } from './preset-sources';
import { InvalidParserConfigError, serializeParserConfig } from './source-config';
import {
  formatSourceSchemaError,
  sourceCreateSchema,
  sourceTestSchema,
} from './source-schema';

export async function listSources() {
  const sources = await db.source.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { articles: true } },
    },
  });

  if (sources.length === 0) return [];

  const sourceIds = sources.map(s => s.id);
  // SQLite 窗口函数一次只取每个 Source 最近 5 条，避免随着历史日志增长
  // 把所有 failure FetchLog 拉入 Node.js 内存后再分组。
  const allLogs = await db.$queryRaw<Array<{
    sourceId: string;
    errorMessage: string;
    createdAt: Date;
  }>>(Prisma.sql`
    SELECT sourceId, errorMessage, createdAt
    FROM (
      SELECT sourceId, errorMessage, createdAt,
             ROW_NUMBER() OVER (PARTITION BY sourceId ORDER BY createdAt DESC) AS row_num
      FROM fetch_logs
      WHERE status = 'failure' AND sourceId IN (${Prisma.join(sourceIds)})
    )
    WHERE row_num <= 5
    ORDER BY createdAt DESC
  `);

  const errorsBySource = new Map<string, { message: string; time: Date }[]>();
  for (const log of allLogs) {
    const list = errorsBySource.get(log.sourceId) || [];
    if (list.length < 5) {
      list.push({ message: log.errorMessage, time: log.createdAt });
      errorsBySource.set(log.sourceId, list);
    }
  }

  return sources.map(source => {
    const { _count, ...sourceData } = source;
    return {
    ...sourceData,
    articleCount: _count.articles,
    recentErrors: errorsBySource.get(source.id) || [],
    };
  });
}

export async function createSource(body: unknown) {
  const parsed = sourceCreateSchema.safeParse(body);
  if (!parsed.success) {
    return { error: formatSourceSchemaError(parsed.error), status: 400 as const };
  }
  const { name, type, url, parserConfig, enabled, publicEnabled } = parsed.data;

  let serializedConfig: string;
  try {
    serializedConfig = serializeParserConfig(parserConfig);
  } catch (error) {
    if (error instanceof InvalidParserConfigError) {
      return { error: error.message, status: 400 as const };
    }
    throw error;
  }

  const source = await db.source.create({
    data: {
      name,
      type,
      url,
      parserConfig: serializedConfig,
      enabled: enabled !== false,
      publicEnabled,
    },
  });

  return { source, status: 201 as const };
}

export async function listPresetSources() {
  const existingSources = await db.source.findMany({
    where: { deletedAt: null },
    select: { url: true, name: true },
  });
  const existingUrls = new Set(existingSources.map(s => s.url));
  const existingNames = new Set(existingSources.map(s => s.name));
  return PRESET_SOURCES.map(preset => ({
    ...preset,
    isAdded: existingUrls.has(preset.url) || existingNames.has(preset.name),
  }));
}

export async function addPresetSources(body: Record<string, unknown>) {
  const { presetIds, addAll } = body;
  let presetsToAdd: typeof PRESET_SOURCES = [];

  if (addAll) {
    presetsToAdd = [...PRESET_SOURCES];
  } else if (Array.isArray(presetIds) && presetIds.length > 0) {
    for (const id of presetIds) {
      const preset = getPresetSourceById(String(id));
      if (preset) presetsToAdd.push(preset);
    }
  } else {
    return { error: 'Provide presetIds array or addAll: true', status: 400 as const };
  }

  const existingSources = await db.source.findMany({
    where: { deletedAt: null },
    select: { url: true, name: true },
  });
  const existingUrls = new Set(existingSources.map(s => s.url));
  const existingNames = new Set(existingSources.map(s => s.name));
  const newPresets = presetsToAdd.filter(
    p => !existingUrls.has(p.url) && !existingNames.has(p.name)
  );

  if (newPresets.length === 0) {
    return {
      added: 0,
      skipped: presetsToAdd.length,
      message: '所有预设源已存在，无需添加',
    };
  }

  const created = await db.$transaction(
    newPresets.map(preset =>
      db.source.create({
        data: {
          name: preset.name,
          type: preset.type,
          url: preset.url,
          parserConfig: preset.parserConfig,
          // 预设源只完成配置，不应因为添加动作立即进入抓取范围；
          // 用户需要在「源管理」中明确启用，启用接口本身也不触发抓取。
          enabled: false,
        },
      })
    )
  );

  return {
    added: created.length,
    skipped: presetsToAdd.length - newPresets.length,
    sources: created,
  };
}

export async function batchToggleSources(body: Record<string, unknown>) {
  const { enabled } = body;
  if (typeof enabled !== 'boolean') {
    return { error: 'enabled (boolean) is required', status: 400 as const };
  }
  const result = await db.source.updateMany({
    where: { deletedAt: null },
    data: { enabled },
  });
  return { success: true, updated: result.count, enabled };
}

export async function retrySource(body: Record<string, unknown>) {
  const sourceIds = Array.isArray(body.sourceIds)
    ? [...new Set(body.sourceIds.slice(0, 50).filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId : sourceIds[0] ?? '';
  if (sourceIds.length > 0) {
    const existing = await db.source.findMany({ where: { id: { in: sourceIds }, deletedAt: null }, select: { id: true } });
    if (existing.length === 0) return { error: 'Source not found', status: 404 as const };
    const res = await runJob('collect', { sourceIds: existing.map(source => source.id), reason: 'retry', trigger: 'manual', resetSourceHealth: true });
    if (!res.queued) return { queued: false, error: '已有抓取任务在执行中' };
    return { queued: true, jobId: res.jobId, sourceIds: existing.map(source => source.id) };
  }
  if (!sourceId) {
    return { error: 'Source ID is required', status: 400 as const };
  }

  const source = await db.source.findFirst({
    where: { id: sourceId, deletedAt: null },
    select: { id: true },
  });
  if (!source) {
    return { error: 'Source not found', status: 404 as const };
  }

  // 健康状态重置属于该 Job 的第一步，避免“先重置、后因并发被拒绝”的半完成写入。
  // 重试数据源只重新采集该源；处理、AI、推送由管理员按阶段明确触发，
  // 避免一次“重试源”意外处理全局待处理文章。
  const res = await runJob('collect', { sourceId, reason: 'retry', trigger: 'manual', resetSourceHealth: true });
  if (!res.queued) {
    return { queued: false, error: '已有抓取任务在执行中' };
  }
  return { queued: true, jobId: res.jobId, sourceId };
}

export async function testSourceParsing(body: unknown) {
  const parsed = sourceTestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      success: false,
      items: [],
      error: formatSourceSchemaError(parsed.error),
      status: 400 as const,
    };
  }

  try {
    return await testCrawlSource(
      parsed.data.type,
      parsed.data.url,
      serializeParserConfig(parsed.data.parserConfig),
    );
  } catch (error) {
    if (error instanceof InvalidParserConfigError) {
      return { success: false, items: [], error: error.message, status: 400 as const };
    }
    throw error;
  }
}
