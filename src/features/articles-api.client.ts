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

export interface ArticleListFilter {
  page?: number;
  pageSize?: number;
  search?: string;
  category?: string;
  brand?: string;
  minScore?: number;
  minRelevance?: number;
  reviewStatus?: string;
  fetchStatus?: string;
  inbox?: boolean;
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
  if (filter.reviewStatus) params.set('reviewStatus', filter.reviewStatus);
  if (filter.fetchStatus) params.set('fetchStatus', filter.fetchStatus);
  if (filter.inbox) params.set('inbox', 'true');

  return requestJson<ArticleListResponseDto>('GET', `/api/articles?${params}`, { signal });
}

export async function reviewArticle(
  articleId: string,
  status: string,
  reasonTags: string[] = [],
): Promise<unknown> {
  return requestJson('POST', '/api/articles/review', { body: { articleId, status, reasonTags } });
}

export async function fetchArticleDetail(
  articleId: string,
  signal?: AbortSignal,
): Promise<ArticleDetailDto> {
  return requestJson<ArticleDetailDto>('GET', `/api/articles/${articleId}`, { signal });
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

export async function triggerArticleReprocess(
  articleId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson('POST', '/api/articles/reprocess', {
    body: { articleId },
    signal,
    // AI 已由服务端 Job 接管；切换页面时仍确保这个短请求能够提交出去。
    keepalive: true,
  });
}

export async function triggerArticleRefetch(
  articleId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson('POST', '/api/articles/refetch', { body: { articleId }, signal });
}

export async function triggerPushArticle(
  articleId: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<unknown> {
  return requestJson('POST', '/api/push', {
    body: { articleId, force: !!options.force },
    signal: options.signal,
  });
}
