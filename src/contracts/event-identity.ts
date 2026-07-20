export const EVENT_SUBJECT_MAX_ITEMS = 3;
export const EVENT_SUBJECT_MAX_LENGTH = 32;
export const EVENT_ACTION_MAX_LENGTH = 32;
export const EVENT_OBJECT_MAX_LENGTH = 80;
export const EVENT_KEY_MAX_LENGTH = 256;

export interface EventIdentity {
  subjects: string[];
  action: string;
  object: string;
}

function cleanComponent(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[|/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeIdentityToken(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function decodeArray(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function normalizeEventSubjects(value: unknown): string[] {
  const decoded = decodeArray(value);
  const values = Array.isArray(decoded)
    ? decoded
    : typeof decoded === 'string'
      ? decoded.split(/[+|/、,，;；\n]/u)
      : [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const subject = cleanComponent(value, EVENT_SUBJECT_MAX_LENGTH);
    const token = normalizeIdentityToken(subject);
    if (!subject || !token || seen.has(token)) continue;
    seen.add(token);
    result.push(subject);
    if (result.length >= EVENT_SUBJECT_MAX_ITEMS) break;
  }
  return result;
}

export function normalizeEventIdentity(input: {
  subjects: unknown;
  action: unknown;
  object: unknown;
}): EventIdentity {
  return {
    subjects: normalizeEventSubjects(input.subjects),
    action: cleanComponent(input.action, EVENT_ACTION_MAX_LENGTH),
    object: cleanComponent(input.object, EVENT_OBJECT_MAX_LENGTH),
  };
}

export function isCompleteEventIdentity(identity: EventIdentity): boolean {
  return identity.subjects.length > 0 && Boolean(identity.action) && Boolean(identity.object);
}

export function buildCanonicalEventKey(identity: EventIdentity): string {
  if (!isCompleteEventIdentity(identity)) return '';
  const subjects = [...identity.subjects].sort((left, right) => {
    const leftToken = normalizeIdentityToken(left);
    const rightToken = normalizeIdentityToken(right);
    return leftToken < rightToken ? -1 : leftToken > rightToken ? 1 : 0;
  });
  return `${subjects.join('+')}/${identity.action}/${identity.object}`.slice(0, EVENT_KEY_MAX_LENGTH);
}

export function serializeEventSubjects(subjects: readonly string[]): string {
  return JSON.stringify(normalizeEventSubjects([...subjects]));
}

export function parseEventSubjects(value: string | null | undefined): string[] {
  return normalizeEventSubjects(value ?? '[]');
}
