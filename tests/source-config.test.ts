import { describe, expect, it } from 'vitest';
import { InvalidParserConfigError, serializeParserConfig } from '@/lib/source-config';

describe('serializeParserConfig', () => {
  it('keeps a JSON string single-encoded across an edit round-trip', () => {
    const input = '{"listItem":".news li","title":"h3"}';
    const stored = serializeParserConfig(input);

    expect(JSON.parse(stored)).toEqual({ listItem: '.news li', title: 'h3' });
    expect(typeof JSON.parse(stored)).toBe('object');
  });

  it('accepts an object and stores canonical JSON', () => {
    expect(serializeParserConfig({ feedUrl: 'https://example.com/rss' }))
      .toBe('{"feedUrl":"https://example.com/rss"}');
  });

  it.each(['not-json', '[]', '"double-encoded"'])('rejects invalid object config: %s', (input) => {
    expect(() => serializeParserConfig(input)).toThrow(InvalidParserConfigError);
  });
});
