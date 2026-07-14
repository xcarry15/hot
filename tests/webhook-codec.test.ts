/**
 * webhook pure contract — 单元测试
 *
 * 覆盖 parse / 两种 serialize 的差异，作为共享语义的事实源。
 */
import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_MAX_COUNT,
  parseWebhookConfigs,
  serializeWebhookConfigsForEditor,
  serializeWebhookConfigsForServer,
  type WebhookConfig,
} from '@/contracts/webhook';

describe('webhook contract', () => {
  describe('parseWebhookConfigs', () => {
    it('returns an empty array for an empty / whitespace input', () => {
      expect(parseWebhookConfigs('')).toEqual([]);
      expect(parseWebhookConfigs('   ')).toEqual([]);
    });

    it('wraps a bare URL string into a single enabled entry (historical format)', () => {
      expect(parseWebhookConfigs('https://example.com/hook')).toEqual([
        { url: 'https://example.com/hook', remark: '', enabled: true },
      ]);
    });

    it('parses a JSON array and keeps entries with a url string', () => {
      const raw = JSON.stringify([
        { url: 'https://a.example/', remark: 'A', enabled: true },
        { url: 'https://b.example/', remark: '', enabled: false },
      ]);
      expect(parseWebhookConfigs(raw)).toEqual([
        { url: 'https://a.example/', remark: 'A', enabled: true },
        { url: 'https://b.example/', remark: '', enabled: false },
      ]);
    });

    it('drops array elements that are not objects with a string url', () => {
      const raw = JSON.stringify([
        { url: 'https://keep.example/' },
        'https://drop-string.example/',
        { remark: 'no-url' },
        { url: 42 },
        null,
      ]);
      expect(parseWebhookConfigs(raw)).toEqual([
        { url: 'https://keep.example/', remark: '', enabled: true },
      ]);
    });

    it('treats missing enabled as enabled (enabled !== false)', () => {
      const raw = JSON.stringify([{ url: 'https://no-flag.example/' }]);
      expect(parseWebhookConfigs(raw)[0].enabled).toBe(true);
    });

    it('treats bare (non-[) strings as a single historical URL entry', () => {
      expect(parseWebhookConfigs('https://history.example/hook')).toEqual([
        { url: 'https://history.example/hook', remark: '', enabled: true },
      ]);
    });

    it('returns [] for malformed JSON starting with [', () => {
      // try/catch 兜底：解析失败返回 []
      expect(parseWebhookConfigs('[invalid json')).toEqual([]);
    });
  });

  describe('serialize modes', () => {
    const configs: WebhookConfig[] = [
      { url: 'https://keep.example/', remark: 'A', enabled: true },
      { url: '   ', remark: 'blank', enabled: true },
      { url: '', remark: 'empty', enabled: true },
      { url: 'https://disabled.example/', remark: 'B', enabled: false },
    ];

    it('server serializer drops entries with empty / whitespace-only url', () => {
      const json = serializeWebhookConfigsForServer(configs);
      const parsed = JSON.parse(json);
      expect(parsed).toEqual([
        { url: 'https://keep.example/', remark: 'A', enabled: true },
        { url: 'https://disabled.example/', remark: 'B', enabled: false },
      ]);
    });

    it('editor serializer preserves empty entries so user drafts round-trip', () => {
      const json = serializeWebhookConfigsForEditor(configs);
      const parsed = JSON.parse(json);
      expect(parsed).toHaveLength(4);
      expect(parsed[1]).toEqual({ url: '   ', remark: 'blank', enabled: true });
      expect(parsed[2]).toEqual({ url: '', remark: 'empty', enabled: true });
    });

    it('server → parse round-trip stays minimal', () => {
      const json = serializeWebhookConfigsForServer(configs);
      expect(parseWebhookConfigs(json)).toEqual([
        { url: 'https://keep.example/', remark: 'A', enabled: true },
        { url: 'https://disabled.example/', remark: 'B', enabled: false },
      ]);
    });

    it('editor → parse round-trip preserves drafts', () => {
      const json = serializeWebhookConfigsForEditor(configs);
      // 原 parseWebhookConfigs 不会 trim URL，因此空白 URL 来回是 '   '
      expect(parseWebhookConfigs(json)).toEqual([
        { url: 'https://keep.example/', remark: 'A', enabled: true },
        { url: '   ', remark: 'blank', enabled: true },
        { url: '', remark: 'empty', enabled: true },
        { url: 'https://disabled.example/', remark: 'B', enabled: false },
      ]);
    });
  });

  it('exposes WEBHOOK_MAX_COUNT as a stable cap', () => {
    expect(WEBHOOK_MAX_COUNT).toBe(10);
  });
});
