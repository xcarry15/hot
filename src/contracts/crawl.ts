/**
 * 抓取流水线与解析器共享的纯类型契约。
 *
 * 解析器只能依赖本文件，不得反向依赖 crawler 编排器或数据库实现。
 */
export interface CrawlItem {
  title: string;
  url: string;
  summary?: string;
  publishedAt?: string;
  content?: string;
}

export interface CrawlResult {
  success: boolean;
  items: CrawlItem[];
  error?: string;
}

export type ParserFn = (
  url: string,
  parserConfig: string,
  signal?: AbortSignal,
) => Promise<CrawlResult>;
