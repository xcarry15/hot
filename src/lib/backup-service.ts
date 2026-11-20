import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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

const BACKUP_SIGNATURE_FIELD = 'signature';
const BACKUP_SIGNING_DOMAIN = '1-hot:backup-signature:v1';

/** 稳定的键排序序列化：签名与校验双方必须对同一份字节串计算 HMAC。 */
function canonicalizeBackupPayload(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalizeBackupPayload).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeBackupPayload(object[key])}`)
    .join(',')}}`;
}

function getBackupSigningSecrets(): string[] {
  const secrets: string[] = [];
  const dedicated = process.env.BACKUP_SIGNING_KEY?.trim();
  if (dedicated) secrets.push(dedicated);
  const configured = process.env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (configured) secrets.push(configured);
  const previous = process.env.SETTINGS_ENCRYPTION_KEY_PREVIOUS?.trim();
  if (previous) secrets.push(previous);
  if (secrets.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('生产环境必须配置 BACKUP_SIGNING_KEY 或 SETTINGS_ENCRYPTION_KEY');
    }
    secrets.push(`hot2-local-backup:${process.env.DATABASE_URL || 'file:./db/custom.db'}`);
  }
  return [...new Set(secrets)];
}

function backupHmac(secret: string, material: string): Buffer {
  const key = createHash('sha256').update(`${BACKUP_SIGNING_DOMAIN}:${secret}`).digest();
  return createHmac('sha256', key).update(material, 'utf8').digest();
}

/** 导出签名：对经过 schema 归一化的载荷计算 HMAC，不把密钥写入备份。 */
function signBackupPayload(payload: ProjectBackupPayload): string {
  const normalized = projectBackupSchema.parse(payload);
  return backupHmac(getBackupSigningSecrets()[0], canonicalizeBackupPayload(normalized)).toString('hex');
}

/**
 * 导入签名校验。旧版本备份没有签名字段，按警告兼容；
 * 有签名但校验失败时明确拒绝，且不输出载荷内容或密钥。
 */
function verifyBackupSignature(input: unknown, backup: ProjectBackupPayload): void {
  const raw = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
  const signature = raw?.[BACKUP_SIGNATURE_FIELD];
  if (typeof signature !== 'string' || !signature.trim()) {
    console.warn('[backup] 备份文件缺少 HMAC 签名，按旧格式兼容导入；建议重新导出以生成签名');
    return;
  }

  const material = canonicalizeBackupPayload(backup);
  const provided = Buffer.from(signature.trim(), 'hex');
  const valid = getBackupSigningSecrets().some((secret) => {
    const expected = backupHmac(secret, material);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
  if (!valid) {
    throw new ProjectBackupValidationError('备份签名校验失败：文件可能被篡改，或使用了不同的签名密钥');
  }
}

function parseSampleTitles(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 5)
      : [];
  } catch (error) {
    console.warn('[backup] Failed to parse sampleTitles:', error);
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

  const payload: ProjectBackupPayload = {
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
  // 签名字段不属于 projectBackupSchema（顶层 strict），因此只在返回时附加。
  return { ...payload, [BACKUP_SIGNATURE_FIELD]: signBackupPayload(payload) } as ProjectBackupPayload;
}

export async function restoreProjectBackup(input: unknown): Promise<ProjectBackupRestoreResult> {
  // 先剥离签名字段再走 strict schema；校验使用归一化后的载荷，与导出侧一致。
  const raw = input && typeof input === 'object' && !Array.isArray(input)
    ? { ...(input as Record<string, unknown>) }
    : input;
  if (raw && typeof raw === 'object') delete (raw as Record<string, unknown>)[BACKUP_SIGNATURE_FIELD];
  const parsed = projectBackupSchema.safeParse(raw);
  if (!parsed.success) throw new ProjectBackupValidationError(formatProjectBackupError(parsed.error));
  const backup = parsed.data as ProjectBackupPayload;
  verifyBackupSignature(input, backup);
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
