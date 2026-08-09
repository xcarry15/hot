import type { ProjectBackupPayload, ProjectBackupRestoreResult } from '@/contracts/backup';
import { requestJson } from '@/lib/request-json.client';

export async function exportProjectBackup(signal?: AbortSignal): Promise<ProjectBackupPayload> {
  return requestJson<ProjectBackupPayload>('POST', '/api/backup', { signal });
}

export async function restoreProjectBackup(
  payload: ProjectBackupPayload,
  signal?: AbortSignal,
): Promise<ProjectBackupRestoreResult> {
  return requestJson<ProjectBackupRestoreResult>('PUT', '/api/backup', { body: payload, signal });
}
