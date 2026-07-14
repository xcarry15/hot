import { describe, expect, it } from 'vitest';
import { splitBrands } from '../src/lib/shared/article-codecs';

describe('splitBrands', () => {
  it('parses pipe-separated brands from AI output', () => {
    expect(splitBrands('星巴克|瑞幸')).toEqual(['星巴克', '瑞幸']);
  });

  it('trims blanks and drops empty items', () => {
    expect(splitBrands(' 星巴克 | | 瑞幸 ')).toEqual(['星巴克', '瑞幸']);
  });
});
