const SOURCE_TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'from', 'source', 'spm', 'track', 'share', 'timestamp', 'ref', 'referrer',
]);

/** 抓取源去重身份：忽略锚点、常见跟踪参数和 URL 书写差异。 */
export function sourceIdentityUrl(value: string): string {
  try {
    const parsed = new URL(value.trim());
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }
    const params = Array.from(parsed.searchParams.entries())
      .filter(([key]) => !SOURCE_TRACKING_PARAMS.has(key.toLowerCase()))
      .sort();
    parsed.search = new URLSearchParams(params).toString();
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return value.trim();
  }
}
