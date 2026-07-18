/**
 * Article feature 的客户端 API 层。
 *
 * 职责：
 *   - 拼装 endpoint（含 query/body）
 *   - 调用 requestJson<T> 拿到强类型 DTO
 *   - 不再让组件直接用 fetch + 错误 try/catch
 *
 * 注意：本文件只能被客户端代码 import；`@/contracts/articles` 是纯 DTO，
 * 所以本模块本身也不依赖 Prisma / db，符合 client/server 边界。
 */
import { isRequestJsonError, requestJson } from '@/lib/request-json.client';
import type {
  ArticleDetailDto,
  ArticleListResponseDto,
} from '@/contracts/articles';
import type { ManualOverrideField } from '@/lib/shared/article-calibration';

const DETAIL_CACHE_TTL_MS = 15_000;
const MAX_DETAIL_CACHE_ENTRIES = 100;
const PREFETCH_DELAY_MS = 120;
const articleDetailPrefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const articleDetailCache = new Map<string, {
  expiresAt: number;
  value: Promise<ArticleDetailDto>;
}>();

function withAbort<T>(value: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return value;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    value.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export function primeArticleDetailCache(article: ArticleDetailDto): void {
  articleDetailCache.delete(article.id);
  articleDetailCache.set(article.id, {
    expiresAt: Date.now() + DETAIL_CACHE_TTL_MS,
    value: Promise.resolve(article),
  });
  trimArticleDetailCache();
}

function trimArticleDetailCache(): void {
  while (articleDetailCache.size > MAX_DETAIL_CACHE_ENTRIES) {
    const oldestKey = articleDetailCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    articleDetailCache.delete(oldestKey);
  }
}

export function invalidateArticleDetailCache(articleId?: string): void {
  if (articleId) articleDetailCache.delete(articleId);
  else articleDetailCache.clear();
}

export interface ArticleListFilter {
  page?: number;
  pageSize?: number;
  search?: string;
  category?: string;
  brand?: string;
  minScore?: number;
  minRelevance?: number;
  maxConfidence?: number;
  reviewStatus?: string;
  fetchStatus?: string;
  inbox?: boolean;
  sourceId?: string;
  anomaly?: 'needs_attention' | 'technical';
  clusterView?: 'needs_review' | 'multi_source' | 'representative';
  manualOnly?: boolean;
  sort?: 'newest' | 'oldest' | 'score_desc' | 'score_asc' | 'relevance_desc' | 'relevance_asc' | 'event_desc' | 'event_asc' | 'content_desc' | 'content_asc' | 'ad_desc' | 'ad_asc' | 'confidence_desc' | 'confidence_asc';
}
export async function fetchArticleList(
  filter: ArticleListFilter,
  signal?: AbortSignal,
): Promise<ArticleListResponseDto> {
  const params = new URLSearchParams();
  if (filter.page != null) params.set('page', String(filter.page));
  if (filter.pageSize != null) params.set('pageSize', String(filter.pageSize));
  if (filter.search) params.set('search', filter.search);
  if (filter.category) params.set('category', filter.category);
  if (filter.brand) params.set('brand', filter.brand);
  if (typeof filter.minScore === 'number') params.set('minScore', String(filter.minScore));
  if (typeof filter.minRelevance === 'number') params.set('minRelevance', String(filter.minRelevance));
  if (typeof filter.maxConfidence === 'number') params.set('maxConfidence', String(filter.maxConfidence));
  if (filter.reviewStatus) params.set('reviewStatus', filter.reviewStatus);
  if (filter.fetchStatus) params.set('fetchStatus', filter.fetchStatus);
  if (filter.inbox) params.set('inbox', 'true');
  if (filter.sourceId) params.set('sourceId', filter.sourceId);
  if (filter.anomaly) params.set('anomaly', filter.anomaly);
  if (filter.clusterView) params.set('clusterView', filter.clusterView);
  if (filter.manualOnly) params.set('manualOnly', 'true');
  if (filter.sort) params.set('sort', filter.sort);

  return requestJson<ArticleListResponseDto>('GET', `/api/articles?${params}`, { signal });
}

export async function updateArticleEditorial(
  articleId: string,
  input: { summary?: string; brand?: string; category?: string; tags?: Array<{ name: string; tone?: string }>; keyPoints?: string[]; publicOverride?: 'auto' | 'public' | 'hidden'; relevance?: number; eventScore?: number; contentScore?: number; adProbability?: number; isAd?: boolean; restoreFields?: ManualOverrideField[] },
): Promise<ArticleDetailDto> {
  const article = await requestJson<ArticleDetailDto>('PATCH', `/api/articles/${articleId}`, { body: input });
  primeArticleDetailCache(article);
  return article;
}

export async function reviewArticle(
  articleId: string,
  status: string,
  reasonTags: string[] = [],
): Promise<unknown> {
  const result = await requestJson('POST', '/api/articles/review', { body: { articleId, status, reasonTags } });
  invalidateArticleDetailCache(articleId);
  return result;
}

export async function reviewArticles(
  articleIds: string[],
  status: string,
  reasonTags: string[] = [],
): Promise<{ updated: number }> {
  const result = await requestJson<{ updated: number }>('POST', '/api/articles/review', { body: { articleIds, status, reasonTags } });
  for (const articleId of articleIds) invalidateArticleDetailCache(articleId);
  return result;
}

export async function fetchArticleDetail(
  articleId: string,
  signal?: AbortSignal,
): Promise<ArticleDetailDto> {
  const cached = articleDetailCache.get(articleId);
  if (cached && cached.expiresAt > Date.now()) return withAbort(cached.value, signal);
  if (cached) articleDetailCache.delete(articleId);

  const value = requestJson<ArticleDetailDto>('GET', `/api/articles/${articleId}`);
  articleDetailCache.set(articleId, {
    expiresAt: Date.now() + DETAIL_CACHE_TTL_MS,
    value,
  });
  trimArticleDetailCache();
  void value.catch(() => articleDetailCache.delete(articleId));
  return withAbort(value, signal);
}

export function prefetchArticleDetail(articleId: string): void {
  const cached = articleDetailCache.get(articleId);
  if (cached && cached.expiresAt > Date.now()) return;
  if (articleDetailPrefetchTimers.has(articleId)) return;
  const timer = setTimeout(() => {
    articleDetailPrefetchTimers.delete(articleId);
    void fetchArticleDetail(articleId).catch(() => undefined);
  }, PREFETCH_DELAY_MS);
  articleDetailPrefetchTimers.set(articleId, timer);
}

export function cancelArticleDetailPrefetch(articleId: string): void {
  const timer = articleDetailPrefetchTimers.get(articleId);
  if (!timer) return;
  clearTimeout(timer);
  articleDetailPrefetchTimers.delete(articleId);
}
export async function triggerArticleWorkflow(
  articleId: string,
  startAt: 'process' | 'cluster' | 'ai' | 'push',
  intent: 'retry' | 'regenerate',
): Promise<{ queued: boolean; jobId?: string; reason?: string }> {
  const result = await requestJson<{ queued: boolean; jobId?: string; reason?: string }>('POST', `/api/articles/${encodeURIComponent(articleId)}/workflow`, {
    body: { startAt, intent },
  });
  if (result.queued) invalidateArticleDetailCache(articleId);
  return result;
}

export async function fetchRelatedByBrand(
  articleId: string,
  take = 5,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await requestJson('GET', `/api/articles/${encodeURIComponent(articleId)}/related-by-brand?take=${take}`, { signal });
  } catch (error) {
    // 文章已被删除或详情页持有旧 ID 时，关联面板应视为暂无数据，不产生未处理 404。
    if (isRequestJsonError(error, 404)) return { items: [] };
    throw error;
  }
}
