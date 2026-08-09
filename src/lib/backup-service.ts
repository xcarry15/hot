import { db } from '@/lib/db';
import {
  PROJECT_BACKUP_TYPE,
  PROJECT_BACKUP_VERSION,
  summarizeProjectBackup,
  type ProjectBackupKeywordCandidate,
  type ProjectBackupPayload,
  type ProjectBackupRestoreResult,
  type ProjectBackupSource,
} from '@/contracts/backup';
import { projectBackupSchema, formatProjectBackupError } from '@/lib/backup-schema';
import { invalidateKeywordRuntimeCaches } from '@/lib/keyword-service';
import { PROMPT_VERSIONS_SETTING_KEY, listPromptVersions } from '@/lib/prompt-version-service';
import { serializeParserConfig } from '@/lib/source-config';
import { mergeSettingsRebuildPlan, SETTINGS_REBUILD_KEY } from '@/lib/settings-rebuild-service';
import {
  exportSettingsValues,
  invalidateSettingsRuntimeCaches,
  updateSettingsInTransaction,
} from '@/lib/settings-service';
import {
  getToolDirectorySnapshot,
  invalidatePublicTools,
  replaceToolDirectorySnapshotInTransaction,
} from '@/lib/tool-directory-service';

export class ProjectBackupValidationError extends Error {
  readonly status = 400;
  readonly exposeToClient = true;

  constructor(message: string) {
    super(message);
    this.name = 'ProjectBackupValidationError';
  }
}

function parseSampleTitles(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 5)
      : [];
  } catch {
    return [];
  }
}

export async function exportProjectBackup(): Promise<ProjectBackupPayload> {
  const [settings, promptVersions, sources, keywords, candidates, toolDirectory] = await Promise.all([
    exportSettingsValues(),
    listPromptVersions(),
    db.source.findMany({
      where: { deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        type: true,
        url: true,
        parserConfig: true,
        enabled: true,
        publicEnabled: true,
      },
    }),
    db.keyword.findMany({
      orderBy: [{ category: 'asc' }, { word: 'asc' }],
      select: { category: true, word: true },
    }),
    db.keywordCandidate.findMany({
      orderBy: [{ createdAt: 'asc' }, { phrase: 'asc' }],
      select: { phrase: true, occurrences: true, sampleTitles: true, status: true },
    }),
    getToolDirectorySnapshot(),
  ]);

  return {
    type: PROJECT_BACKUP_TYPE,
    version: PROJECT_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings,
    promptVersions,
    sources: sources.map((source): ProjectBackupSource => ({
      ...source,
      type: source.type as ProjectBackupSource['type'],
    })),
    keywords: {
      entries: keywords,
      candidates: candidates.map((candidate): ProjectBackupKeywordCandidate => ({
        phrase: candidate.phrase,
        occurrences: candidate.occurrences,
        sampleTitles: parseSampleTitles(candidate.sampleTitles),
        status: candidate.status as ProjectBackupKeywordCandidate['status'],
      })),
    },
    toolDirectory,
  };
}

export async function restoreProjectBackup(input: unknown): Promise<ProjectBackupRestoreResult> {
  const parsed = projectBackupSchema.safeParse(input);
  if (!parsed.success) throw new ProjectBackupValidationError(formatProjectBackupError(parsed.error));
  const backup = parsed.data as unknown as ProjectBackupPayload;
  let sources: ProjectBackupSource[];
  try {
    sources = backup.sources.map((source) => ({
      ...source,
      parserConfig: serializeParserConfig(source.parserConfig),
    }));
  } catch (error) {
    throw new ProjectBackupValidationError(error instanceof Error ? error.message : '数据源解析配置无效');
  }

  await db.$transaction(async (tx) => {
    const settingsResult = await updateSettingsInTransaction(tx, backup.settings, {
      preserveRedactedSensitive: false,
    });
    if (!settingsResult.ok) {
      const detail = settingsResult.details.map(String).filter(Boolean).join('；');
      throw new ProjectBackupValidationError(detail || settingsResult.error);
    }

    await tx.setting.upsert({
      where: { key: PROMPT_VERSIONS_SETTING_KEY },
      update: { value: JSON.stringify(backup.promptVersions) },
      create: { key: PROMPT_VERSIONS_SETTING_KEY, value: JSON.stringify(backup.promptVersions) },
    });

    const sourceIds = sources.map((source) => source.id);
    await tx.source.updateMany({
      where: sourceIds.length > 0
        ? { deletedAt: null, id: { notIn: sourceIds } }
        : { deletedAt: null },
      data: { deletedAt: new Date(), enabled: false },
    });
    for (const source of sources) {
      const data = {
        name: source.name,
        type: source.type,
        url: source.url,
        parserConfig: source.parserConfig,
        enabled: source.enabled,
        publicEnabled: source.publicEnabled,
        status: 'never_fetched',
        consecutiveFailures: 0,
        circuitBreakerUntil: null,
        lastFetchedAt: null,
        deletedAt: null,
      };
      await tx.source.upsert({ where: { id: source.id }, update: data, create: { id: source.id, ...data } });
    }

    const existingKeywords = await tx.keyword.findMany({ select: { id: true, category: true, word: true } });
    const keywordKeys = new Set(backup.keywords.entries.map((item) => `${item.category}\u0000${item.word}`));
    const existingKeywordKeys = new Set(existingKeywords.map((item) => `${item.category}\u0000${item.word}`));
    const missingKeywords = backup.keywords.entries.filter((item) => !existingKeywordKeys.has(`${item.category}\u0000${item.word}`));
    if (missingKeywords.length > 0) await tx.keyword.createMany({ data: missingKeywords });
    const removedKeywordIds = existingKeywords
      .filter((item) => !keywordKeys.has(`${item.category}\u0000${item.word}`))
      .map((item) => item.id);
    if (removedKeywordIds.length > 0) await tx.keyword.deleteMany({ where: { id: { in: removedKeywordIds } } });

    await tx.keywordCandidate.deleteMany({});
    if (backup.keywords.candidates.length > 0) {
      await tx.keywordCandidate.createMany({
        data: backup.keywords.candidates.map((candidate) => ({
          phrase: candidate.phrase,
          occurrences: candidate.occurrences,
          sampleTitles: JSON.stringify(candidate.sampleTitles),
          status: candidate.status,
        })),
      });
    }

    await replaceToolDirectorySnapshotInTransaction(tx, backup.toolDirectory);
    await tx.discardedItem.deleteMany({ where: { reason: { startsWith: 'filter:' } } });

    const marker = await tx.setting.findUnique({
      where: { key: SETTINGS_REBUILD_KEY },
      select: { value: true },
    });
    const rebuildPlan = mergeSettingsRebuildPlan(marker?.value, { score: false, publication: true });
    await tx.setting.upsert({
      where: { key: SETTINGS_REBUILD_KEY },
      update: { value: JSON.stringify(rebuildPlan) },
      create: { key: SETTINGS_REBUILD_KEY, value: JSON.stringify(rebuildPlan) },
    });
  }, { maxWait: 10_000, timeout: 30_000 });

  invalidateSettingsRuntimeCaches();
  invalidateKeywordRuntimeCaches();
  invalidatePublicTools();

  return {
    summary: summarizeProjectBackup(backup),
    rebuildQueued: true,
  };
}
