import { z } from 'zod';
import { PROJECT_BACKUP_TYPE, PROJECT_BACKUP_VERSION } from '@/contracts/backup';
import { PROMPT_VERSION_KEYS, PROMPT_VERSION_LIMIT } from '@/lib/prompts';
import { EXPORTABLE_SETTING_KEYS } from '@/lib/settings-catalog';
import { SOURCE_TYPES, sourceCreateSchema } from '@/lib/source-schema';
import { sourceIdentityUrl } from '@/lib/source-identity';
import { toolDirectorySnapshotSchema } from '@/lib/tool-directory-schema';

const promptKeySet = new Set<string>(PROMPT_VERSION_KEYS);
const exportableSettingKeySet = new Set<string>(EXPORTABLE_SETTING_KEYS);

const promptSnapshotSchema = z.record(z.string(), z.string()).superRefine((value, context) => {
  const keys = Object.keys(value);
  for (const key of PROMPT_VERSION_KEYS) {
    const prompt = value[key];
    if (typeof prompt !== 'string' || !prompt.trim()) {
      context.addIssue({ code: 'custom', path: [key], message: `提示词 ${key} 不能为空` });
    } else if (prompt.length > 20_000) {
      context.addIssue({ code: 'custom', path: [key], message: `提示词 ${key} 内容过长` });
    }
  }
  if (keys.some((key) => !promptKeySet.has(key))) {
    context.addIssue({ code: 'custom', message: '提示词版本包含未知字段' });
  }
});

const promptVersionSchema = z.object({
  id: z.string().trim().min(1, '提示词版本 ID 无效').max(100, '提示词版本 ID 无效'),
  name: z.string().trim().min(1, '提示词版本名称不能为空').max(40, '提示词版本名称过长'),
  createdAt: z.string().datetime({ offset: true, message: '提示词版本时间无效' }),
  prompts: promptSnapshotSchema,
}).strict();

const sourceSnapshotSchema = z.object({
  id: z.string().trim().min(1, '数据源 ID 无效').max(100, '数据源 ID 无效'),
  name: sourceCreateSchema.shape.name,
  type: z.enum(SOURCE_TYPES),
  url: sourceCreateSchema.shape.url,
  parserConfig: z.string().max(100_000, '数据源解析配置过长'),
  enabled: z.boolean(),
  publicEnabled: z.boolean(),
}).strict().superRefine((value, context) => {
  // 验证数据源 URL 格式
  try {
    new URL(value.url);
  } catch {
    context.addIssue({ code: 'custom', path: ['url'], message: '数据源 URL 格式无效' });
  }
});

const keywordSchema = z.object({
  category: z.string().trim().min(1, '关键词分类不能为空').max(100, '关键词分类过长'),
  word: z.string().trim().min(1, '关键词不能为空').max(200, '关键词过长'),
}).strict();

const keywordCandidateSchema = z.object({
  phrase: z.string().trim().min(1, '候选词不能为空').max(100, '候选词过长'),
  occurrences: z.number().int('候选词次数无效').min(1, '候选词次数无效').max(1_000_000, '候选词次数过大'),
  sampleTitles: z.array(z.string().trim().min(1).max(2_000)).max(5, '候选词示例标题过多'),
  status: z.enum(['pending', 'approved', 'dismissed']),
}).strict();

export const projectBackupSchema = z.object({
  type: z.literal(PROJECT_BACKUP_TYPE),
  version: z.literal(PROJECT_BACKUP_VERSION),
  exportedAt: z.string().datetime({ offset: true, message: '备份时间无效' }),
  settings: z.record(z.string(), z.string()).refine(
    (settings) => Object.keys(settings).length > 0,
    '备份中没有设置数据',
  ),
  promptVersions: z.array(promptVersionSchema).max(PROMPT_VERSION_LIMIT, '提示词版本数量超过上限'),
  sources: z.array(sourceSnapshotSchema).max(2_000, '数据源数量超过上限'),
  keywords: z.object({
    entries: z.array(keywordSchema).max(50_000, '关键词数量超过上限'),
    candidates: z.array(keywordCandidateSchema).max(50_000, '候选词数量超过上限'),
  }).strict(),
  toolDirectory: toolDirectorySnapshotSchema,
}).strict().superRefine((value, context) => {
  const settingKeys = Object.keys(value.settings);
  const missingSettingKeys = EXPORTABLE_SETTING_KEYS.filter((key) => !settingKeys.includes(key));
  const unknownSettingKeys = settingKeys.filter((key) => !exportableSettingKeySet.has(key));
  if (missingSettingKeys.length > 0) {
    context.addIssue({ code: 'custom', path: ['settings'], message: '备份缺少当前版本所需的设置项' });
  }
  if (unknownSettingKeys.length > 0) {
    context.addIssue({ code: 'custom', path: ['settings'], message: '备份包含当前版本不支持的设置项' });
  }

  const uniqueChecks: Array<{ path: Array<string | number>; values: string[]; message: string }> = [
    { path: ['promptVersions'], values: value.promptVersions.map((item) => item.id), message: '提示词版本 ID 不能重复' },
    { path: ['sources'], values: value.sources.map((item) => item.id), message: '数据源 ID 不能重复' },
    { path: ['sources'], values: value.sources.map((item) => sourceIdentityUrl(item.url)), message: '数据源 URL 不能重复' },
    { path: ['keywords', 'entries'], values: value.keywords.entries.map((item) => `${item.category}\u0000${item.word}`), message: '关键词不能重复' },
    { path: ['keywords', 'candidates'], values: value.keywords.candidates.map((item) => item.phrase), message: '候选词不能重复' },
  ];
  for (const check of uniqueChecks) {
    if (new Set(check.values).size !== check.values.length) {
      context.addIssue({ code: 'custom', path: check.path, message: check.message });
    }
  }
});

export function formatProjectBackupError(error: z.ZodError): string {
  return error.issues[0]?.message || '备份文件格式无效';
}
