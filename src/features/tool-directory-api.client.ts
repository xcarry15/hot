import { requestJson } from '@/lib/request-json.client';
import type { ToolDirectoryItemDto } from '@/contracts/tool-directory';

export interface ToolDirectoryInput {
  name: string;
  description: string;
  category: ToolDirectoryItemDto['category'];
  href: string | null;
  icon: ToolDirectoryItemDto['icon'];
  kind: ToolDirectoryItemDto['kind'];
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
