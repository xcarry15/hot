/**
 * URL 工具函数 —— 相对路径解析 + URL 标准化。
 */

/**
 * 将相对路径解析为绝对 URL（基于 baseUrl）。
 * 使用标准 URL 解析器处理所有相对路径形式。
 */
export function resolveUrl(href: string, baseUrl: string): string {
  try {
    const resolved = new URL(href, baseUrl);
    if (!['http:', 'https:'].includes(resolved.protocol)) {
      throw new Error('Unsupported URL protocol');
    }
    return resolved.toString();
  } catch {
    return href;
  }
}

/** 已知的跟踪参数列表。 */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'from', 'source', 'spm', 'track', 'share', 'timestamp', 'ref', 'referrer',
  'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid',
]);

/**
 * 标准化 URL：去 fragment、移除跟踪参数、排序 query、去末尾斜杠。
 * 用于入库前的精确去重（URL 唯一约束）。
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const params = Array.from(parsed.searchParams.entries())
      .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
      .sort();
    parsed.search = new URLSearchParams(params).toString();
    const pathname =
      parsed.pathname.endsWith('/') && parsed.pathname !== '/'
        ? parsed.pathname.slice(0, -1)
        : parsed.pathname;
    parsed.pathname = pathname;
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
