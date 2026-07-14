/**
 * URL 工具函数 —— 相对路径解析 + URL 标准化。
 *
 * 历史：resolveUrl 在 parser-html.ts，normalizeUrl 在 crawler.ts，
 * parser-canyin88 内联做 URL 规范化。现统一收敛。
 */

/**
 * 将相对路径解析为绝对 URL（基于 baseUrl）。
 * href 已是绝对地址 → 直接返回。
 */
export function resolveUrl(href: string, baseUrl: string): string {
  if (href.startsWith('http')) return href;
  if (href.startsWith('/')) {
    try {
      const base = new URL(baseUrl);
      return `${base.origin}${href}`;
    } catch {
      return href;
    }
  }
  return href;
}

/**
 * 标准化 URL：去 fragment、排序 query、去末尾斜杠。
 * 用于入库前的精确去重（URL 唯一约束）。
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const params = Array.from(parsed.searchParams.entries()).sort();
    parsed.search = new URLSearchParams(params).toString();
    const pathname =
      parsed.pathname.endsWith('/') && parsed.pathname !== '/'
        ? parsed.pathname.slice(0, -1)
        : parsed.pathname;
    parsed.pathname = pathname;
    return parsed.toString();
  } catch {
    return url;
  }
}
