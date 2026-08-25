import { describe, expect, it } from 'vitest';
import { isKnownUndiciAbortRace } from '@/instrumentation';

describe('Undici abort race guard', () => {
  it('只识别 Undici DNS interceptor 的已知空引用竞态', () => {
    const error = new TypeError("Cannot read properties of null (reading 'port')");
    error.stack = `${error.name}: ${error.message}\n    at DNSInstance.runLookup (node_modules/undici/lib/interceptor/dns.js:195:27)`;

    expect(isKnownUndiciAbortRace(error)).toBe(true);
  });

  it('不吞掉消息相同但来源无关的业务异常', () => {
    const error = new TypeError("Cannot read properties of null (reading 'host')");
    error.stack = `${error.name}: ${error.message}\n    at renderArticle (src/lib/article-service.ts:10:3)`;

    expect(isKnownUndiciAbortRace(error)).toBe(false);
    expect(isKnownUndiciAbortRace(new Error(error.message))).toBe(false);
  });
});
