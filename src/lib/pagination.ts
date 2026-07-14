/** 严格规范化外部分页值，禁止把 NaN、负数或半截数字传给 Prisma。 */
export function normalizePositiveInt(value: unknown, fallback: number, max?: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN;

  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return max === undefined ? parsed : Math.min(parsed, max);
}

export function parsePositiveInt(raw: string | null, fallback: number, max?: number): number {
  return normalizePositiveInt(raw, fallback, max);
}
