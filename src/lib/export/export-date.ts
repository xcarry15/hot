export function parseShanghaiDate(value: string): Date | undefined {
  if (!value) return undefined;
  const text = value.trim();
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const candidate = hasTimezone
    ? text
    : /^\d{4}-\d{2}-\d{2}$/.test(text)
      ? `${text}T00:00:00+08:00`
      : `${text}+08:00`;
  const date = new Date(candidate);
  return Number.isFinite(date.getTime()) ? date : undefined;
}
