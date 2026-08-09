import type { PromptVersionSnapshot } from '@/lib/prompts';
import type { ToolDirectorySnapshot } from '@/contracts/tool-directory';

export const PROJECT_BACKUP_TYPE = 'hot2-project-backup' as const;
export const PROJECT_BACKUP_VERSION = 1 as const;

export interface ProjectBackupSource {
  id: string;
  name: string;
  type: 'html' | 'rss' | 'websearch' | 'canyin88';
  url: string;
  parserConfig: string;
  enabled: boolean;
  publicEnabled: boolean;
}

export interface ProjectBackupKeyword {
  category: string;
  word: string;
}

export interface ProjectBackupKeywordCandidate {
  phrase: string;
  occurrences: number;
  sampleTitles: string[];
  status: 'pending' | 'approved' | 'dismissed';
}

export interface ProjectBackupPromptVersion {
  id: string;
  name: string;
  createdAt: string;
  prompts: PromptVersionSnapshot;
}

export interface ProjectBackupPayload {
  type: typeof PROJECT_BACKUP_TYPE;
  version: typeof PROJECT_BACKUP_VERSION;
  exportedAt: string;
  settings: Record<string, string>;
  promptVersions: ProjectBackupPromptVersion[];
  sources: ProjectBackupSource[];
  keywords: {
    entries: ProjectBackupKeyword[];
    candidates: ProjectBackupKeywordCandidate[];
  };
  toolDirectory: ToolDirectorySnapshot;
}

export interface ProjectBackupSummary {
  settings: number;
  promptVersions: number;
  sources: number;
  keywords: number;
  keywordCandidates: number;
  toolCategories: number;
  tools: number;
}

export interface ProjectBackupRestoreResult {
  summary: ProjectBackupSummary;
  rebuildQueued: boolean;
  rebuildJobQueued?: boolean;
  rebuildDeferred?: boolean;
}

export function summarizeProjectBackup(payload: ProjectBackupPayload): ProjectBackupSummary {
  return {
    settings: Object.keys(payload.settings).length,
    promptVersions: payload.promptVersions.length,
    sources: payload.sources.length,
    keywords: payload.keywords.entries.length,
    keywordCandidates: payload.keywords.candidates.length,
    toolCategories: payload.toolDirectory.categories.length,
    tools: payload.toolDirectory.tools.length,
  };
}
