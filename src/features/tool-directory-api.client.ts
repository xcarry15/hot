import { requestJson } from '@/lib/request-json.client';
import type {
  ToolDirectoryBackupPayload,
  ToolDirectoryCategoryDto,
  ToolDirectoryItemDto,
} from '@/contracts/tool-directory';

export interface ToolDirectoryInput {
  name: string;
  description: string;
  category: ToolDirectoryItemDto['category'];
  href: string | null;
  icon: ToolDirectoryItemDto['icon'];
  status: ToolDirectoryItemDto['status'];
  tags: ToolDirectoryItemDto['tags'];
}

export async function fetchToolDirectory(includeArchived = false, signal?: AbortSignal): Promise<ToolDirectoryItemDto[]> {
  const query = includeArchived ? '?includeArchived=1' : '';
  return requestJson<ToolDirectoryItemDto[]>('GET', `/api/tools${query}`, { signal });
}

export async function createToolDirectoryItem(
  input: ToolDirectoryInput,
  signal?: AbortSignal,
): Promise<ToolDirectoryItemDto> {
  return requestJson<ToolDirectoryItemDto>('POST', '/api/tools', { body: input, signal });
}

export async function updateToolDirectoryItem(
  id: string,
  input: Partial<ToolDirectoryInput>,
  signal?: AbortSignal,
): Promise<ToolDirectoryItemDto> {
  return requestJson<ToolDirectoryItemDto>('PUT', `/api/tools/${id}`, { body: input, signal });
}

export async function archiveToolDirectoryItem(id: string, signal?: AbortSignal): Promise<ToolDirectoryItemDto> {
  return requestJson<ToolDirectoryItemDto>('DELETE', `/api/tools/${id}`, { signal });
}

export async function restoreToolDirectoryItem(id: string, signal?: AbortSignal): Promise<ToolDirectoryItemDto> {
  return requestJson<ToolDirectoryItemDto>('POST', `/api/tools/${id}/restore`, { signal });
}

export async function moveToolDirectoryItem(
  id: string,
  direction: 'up' | 'down',
  signal?: AbortSignal,
): Promise<ToolDirectoryItemDto> {
  return requestJson<ToolDirectoryItemDto>('POST', '/api/tools/reorder', {
    body: { id, direction },
    signal,
  });
}

export async function fetchToolDirectoryCategories(signal?: AbortSignal): Promise<ToolDirectoryCategoryDto[]> {
  return requestJson<ToolDirectoryCategoryDto[]>('GET', '/api/tools/categories', { signal });
}

export async function updateToolDirectoryCategory(
  id: ToolDirectoryCategoryDto['id'],
  name: string,
  signal?: AbortSignal,
): Promise<ToolDirectoryCategoryDto> {
  return requestJson<ToolDirectoryCategoryDto>('PUT', `/api/tools/categories/${id}`, {
    body: { name },
    signal,
  });
}

export async function moveToolDirectoryCategory(
  id: ToolDirectoryCategoryDto['id'],
  direction: 'up' | 'down',
  signal?: AbortSignal,
): Promise<ToolDirectoryCategoryDto> {
  return requestJson<ToolDirectoryCategoryDto>('POST', '/api/tools/categories/reorder', {
    body: { id, direction },
    signal,
  });
}

export async function exportToolDirectoryBackup(signal?: AbortSignal): Promise<ToolDirectoryBackupPayload> {
  return requestJson<ToolDirectoryBackupPayload>('GET', '/api/tools/backup', { signal });
}

export async function restoreToolDirectoryBackup(
  backup: ToolDirectoryBackupPayload,
  signal?: AbortSignal,
): Promise<{ categoryCount: number; toolCount: number }> {
  return requestJson<{ categoryCount: number; toolCount: number }>('POST', '/api/tools/backup', {
    body: backup,
    signal,
  });
}
