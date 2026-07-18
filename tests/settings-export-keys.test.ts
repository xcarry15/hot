/**
 * EXPORTABLE_SETTING_KEYS 键清单回归测试
 */
import { describe, it, expect } from 'vitest';
import { EXPORTABLE_SETTING_KEYS } from '@/lib/settings';

describe('EXPORTABLE_SETTING_KEYS', () => {
  const set = new Set(EXPORTABLE_SETTING_KEYS);

  it('包含 AI 模型、推送和调度的核心参数键', () => {
    for (const k of [
      'ai_provider', 'ai_temperature', 'ai_max_tokens', 'ai_system_prompt',
      'ai_step2_content_max_chars', 'ai_weight_event', 'ai_weight_content',
      'opencode_api_key', 'opencode_base_url', 'opencode_model',
      'deepseek_api_key', 'deepseek_base_url', 'deepseek_model',
      'push_mode', 'push_min_score', 'push_min_relevance', 'push_time', 'feishu_webhook_url',
      'auto_crawl_enabled', 'crawl_interval_min',
    ]) {
      expect(set.has(k), `缺少键 ${k}`).toBe(true);
    }
  });

  it('包含全部 9 个提示词块键', () => {
    for (const k of [
      'ai_block_ad', 'ai_block_event_score', 'ai_block_category', 'ai_block_relevance',
      'ai_block_content_score', 'ai_block_key_points', 'ai_block_summary',
      'ai_block_tags', 'ai_block_brand',
    ]) {
      expect(set.has(k), `缺少提示词块键 ${k}`).toBe(true);
    }
  });

  it('排除运行态与账户 token', () => {
    for (const k of ['scheduler_last_crawl_at', 'scheduler_last_push_date', 'api_token']) {
      expect(set.has(k), `不应包含 ${k}`).toBe(false);
    }
  });

  it('无重复键', () => {
    expect(set.size).toBe(EXPORTABLE_SETTING_KEYS.length);
  });
});
