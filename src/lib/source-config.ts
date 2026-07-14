export class InvalidParserConfigError extends Error {
  constructor(message = 'parserConfig 必须是 JSON 对象') {
    super(message);
    this.name = 'InvalidParserConfigError';
  }
}

/**
 * Canonicalize parserConfig at the API boundary.
 *
 * Callers may submit either a JSON string (the current UI shape) or an object.
 * Persistence always receives exactly one JSON encoding of an object.
 */
export function serializeParserConfig(value: unknown): string {
  let parsed: unknown;
  if (typeof value === 'string') {
    const raw = value.trim() || '{}';
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new InvalidParserConfigError('parserConfig 不是合法 JSON');
    }
  } else if (value === undefined) {
    parsed = {};
  } else {
    parsed = value;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidParserConfigError();
  }
  return JSON.stringify(parsed);
}
