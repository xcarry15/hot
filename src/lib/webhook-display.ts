/**
 * Webhook 是凭据，不可作为 API DTO 的可见标识。
 * 保留 host 与末尾少量字符只用于人工排查，永不保留 query/hash 或完整 token。
 */
export function maskWebhookTarget(webhookUrl: string): string {
  try {
    const parsed = new URL(webhookUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const secret = parts.at(-1) ?? '';
    const suffix = secret.length > 4 ? secret.slice(-4) : secret;
    return `${parsed.protocol}//${parsed.host}/…/${suffix ? `***${suffix}` : '***'}`;
  } catch {
    return '已隐藏的 Webhook';
  }
}
