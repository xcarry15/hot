import { requestJson } from '@/lib/request-json.client';
import type {
  ExportFilter,
  ExportJobDto,
  ExportJobListResponse,
  ExportJobResponse,
} from '@/contracts/data-export';

export async function listDataExportJobs(signal?: AbortSignal): Promise<ExportJobDto[]> {
  const result = await requestJson<ExportJobListResponse>('GET', '/api/data-export', { signal });
  return result.jobs;
}

export async function createDataExportJob(filter: ExportFilter, signal?: AbortSignal): Promise<ExportJobDto> {
  const result = await requestJson<ExportJobResponse>('POST', '/api/data-export', { body: { filter }, signal });
  return result.job;
}

export async function getDataExportJob(id: string, signal?: AbortSignal): Promise<ExportJobDto> {
  const result = await requestJson<ExportJobResponse>('GET', `/api/data-export/${encodeURIComponent(id)}`, { signal });
  return result.job;
}

export async function cancelDataExportJob(id: string, signal?: AbortSignal): Promise<ExportJobDto> {
  const result = await requestJson<ExportJobResponse>('POST', `/api/data-export/${encodeURIComponent(id)}/cancel`, { signal });
  return result.job;
}

export async function retryDataExportJob(id: string, signal?: AbortSignal): Promise<ExportJobDto> {
  const result = await requestJson<ExportJobResponse>('POST', `/api/data-export/${encodeURIComponent(id)}/retry`, { signal });
  return result.job;
}

export async function deleteDataExportJob(id: string, signal?: AbortSignal): Promise<void> {
  await requestJson<{ ok: true }>('DELETE', `/api/data-export/${encodeURIComponent(id)}`, { signal });
}

export async function downloadDataExportFile(id: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/api/data-export/${encodeURIComponent(id)}/download`, { signal });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/)?.[1]
    ? decodeURIComponent(response.headers.get('Content-Disposition')!.match(/filename="?([^";]+)"?/)![1])
    : `hot2-export-${id}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
}
