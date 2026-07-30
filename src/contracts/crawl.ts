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
  /** 本次真正写入 Article 的数量；items 仅代表列表页解析结果。 */
  createdCount?: number;
  /** 本次命中既有 URL、未新建 Article 的数量。 */
  deduplicatedCount?: number;
  /** 从同 URL 的已删除来源接管并恢复为待处理的文章数量。 */
  reclaimedCount?: number;
}

export type ParserFn = (
  url: string,
  parserConfig: string,
  signal?: AbortSignal,
) => Promise<CrawlResult>;
