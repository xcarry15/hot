import {
  executeSingleArticleWorkflow,
  isSingleWorkflow,
} from './execution-article-workflow';
import { clusterAllPending } from './pipeline/cluster';
import { processAllPending } from './pipeline/process';
import { pushAllPendingArticles } from './pipeline/push-bridge';

export async function executeClusterJob(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  if (isSingleWorkflow(payload)) return executeSingleArticleWorkflow(payload, signal, jobId);
  return { result: await clusterAllPending(signal, jobId) };
}

export async function executeProcessJob(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  if (isSingleWorkflow(payload)) return executeSingleArticleWorkflow(payload, signal, jobId);
  const result = await processAllPending(signal, jobId);
  return { result };
}

export async function executePushJob(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  if (isSingleWorkflow(payload)) return executeSingleArticleWorkflow(payload, signal, jobId);
  const result = await pushAllPendingArticles(signal, jobId);
  return { result };
}
