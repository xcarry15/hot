import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/lib/db';
import { PROMPT_VERSION_KEYS, PROMPT_VERSION_LIMIT, type PromptVersionSnapshot } from '@/lib/prompts';

export const PROMPT_VERSIONS_SETTING_KEY = 'prompt_versions_v1';
const MAX_PROMPT_LENGTH = 20_000;

export interface PromptVersion {
  id: string;
  name: string;
  createdAt: string;
  prompts: PromptVersionSnapshot;
}

const createPromptVersionSchema = z.object({
  name: z.string().trim().min(1, '版本名称不能为空').max(40, '版本名称不能超过 40 个字符'),
  prompts: z.record(z.string(), z.string()),
});

function parseSnapshot(value: unknown): PromptVersionSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const snapshot = {} as PromptVersionSnapshot;
  for (const key of PROMPT_VERSION_KEYS) {
    const prompt = source[key];
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) return null;
    snapshot[key] = prompt;
  }
  return snapshot;
}

function parseStoredVersions(value: string | null | undefined): PromptVersion[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): PromptVersion[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const prompts = parseSnapshot(record.prompts);
      if (
        typeof record.id !== 'string'
        || !record.id
        || typeof record.name !== 'string'
        || !record.name.trim()
        || record.name.length > 40
        || typeof record.createdAt !== 'string'
        || Number.isNaN(Date.parse(record.createdAt))
        || !prompts
      ) return [];
      return [{
        id: record.id,
        name: record.name.trim(),
        createdAt: record.createdAt,
        prompts,
      }];
    }).slice(0, PROMPT_VERSION_LIMIT);
  } catch {
    return [];
  }
}

async function readPromptVersions(): Promise<PromptVersion[]> {
  const row = await db.setting.findUnique({
    where: { key: PROMPT_VERSIONS_SETTING_KEY },
    select: { value: true },
  });
  return parseStoredVersions(row?.value);
}

export async function listPromptVersions(): Promise<PromptVersion[]> {
  return readPromptVersions();
}

export async function createPromptVersion(input: unknown): Promise<PromptVersion> {
  const parsed = createPromptVersionSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '提示词版本格式无效');
  const prompts = parseSnapshot(parsed.data.prompts);
  if (!prompts) throw new Error('提示词版本必须包含全部提示词，且内容不能为空');

  const version: PromptVersion = {
    id: randomUUID(),
    name: parsed.data.name,
    createdAt: new Date().toISOString(),
    prompts,
  };
  const versions = await readPromptVersions();
  const next = [version, ...versions].slice(0, PROMPT_VERSION_LIMIT);
  await db.setting.upsert({
    where: { key: PROMPT_VERSIONS_SETTING_KEY },
    update: { value: JSON.stringify(next) },
    create: { key: PROMPT_VERSIONS_SETTING_KEY, value: JSON.stringify(next) },
  });
  return version;
}

export async function deletePromptVersion(id: string): Promise<boolean> {
  if (!id.trim()) throw new Error('提示词版本标识无效');
  const versions = await readPromptVersions();
  const next = versions.filter((version) => version.id !== id);
  if (next.length === versions.length) return false;
  await db.setting.upsert({
    where: { key: PROMPT_VERSIONS_SETTING_KEY },
    update: { value: JSON.stringify(next) },
    create: { key: PROMPT_VERSIONS_SETTING_KEY, value: JSON.stringify(next) },
  });
  return true;
}
