/**
 * 人工校准契约的纯共享部分。
 * 该文件只能依赖运行时无关代码，收件箱客户端可以安全引用。
 */
export const MANUAL_OVERRIDE_FIELDS = [
  'relevance', 'summary', 'brand', 'category', 'tags', 'keyPoints',
  'eventScore', 'contentScore', 'adProbability', 'isAd',
] as const;

export type ManualOverrideField = (typeof MANUAL_OVERRIDE_FIELDS)[number];

export function parseManualOverrides(value: string | null | undefined): ManualOverrideField[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is ManualOverrideField => (
      typeof item === 'string' && MANUAL_OVERRIDE_FIELDS.includes(item as ManualOverrideField)
    )))];
  } catch {
    return [];
  }
}

export function parseArticleAiSnapshot(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function getSnapshotValue(
  value: string | null | undefined,
  field: ManualOverrideField,
): string | number | boolean | undefined {
  const result = parseArticleAiSnapshot(value)[field];
  return typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean'
    ? result
    : undefined;
}
