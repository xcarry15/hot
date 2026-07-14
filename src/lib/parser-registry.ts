/**
 * 解析器注册表 —— 集中管理所有解析器，消除 crawler.ts 中多处重复的 switch-case。
 *
 * 新增解析器只需在此文件加一行映射，crawlSource / testCrawlSource 自动生效。
 */

import { parseCanyin88 } from './parser-canyin88';
import { parseRss } from './parser-rss';
import { parseHtml } from './parser-html';
import { parseWebSearch } from './parser-websearch';
import type { CrawlResult, ParserFn } from '@/contracts/crawl';
import { SOURCE_TYPES, type SourceType } from './source-schema';

export type { CrawlResult, ParserFn } from '@/contracts/crawl';

export { SOURCE_TYPES };
export type { SourceType };

const PARSER_MAP: Record<string, ParserFn> = {
  canyin88: (url, _config, signal) => parseCanyin88(url, signal),
  rss: (url, config, signal) => parseRss(url, config, signal),
  websearch: (url, config, signal) => parseWebSearch(url, config, signal),
  html: (url, config, signal) => parseHtml(url, config, signal),
};

export class UnknownParserTypeError extends Error {
  constructor(type: string) {
    super(`未知数据源类型: ${type}`);
    this.name = 'UnknownParserTypeError';
  }
}

/**
 * 按 source.type 分发到对应解析器。
 * @param type   source.type: 'html' | 'rss' | 'websearch' | 'canyin88'
 * @param url    source.url 列表页地址
 * @param config source.parserConfig JSON 字符串
 */
export async function dispatchParser(
  type: string,
  url: string,
  config: string,
  signal?: AbortSignal,
): Promise<CrawlResult> {
  const parser = PARSER_MAP[type];
  if (!parser) throw new UnknownParserTypeError(type);
  return parser(url, config, signal);
}
