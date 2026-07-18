/**
 * 共享类型 & 常量 — settings 各子页共用
 *
 * 由父级 settings-tab.tsx 持有状态，子页通过 props 接收
 */

import type { PromptBlockKey } from '@/lib/prompts'
import { FRONTEND_SETTING_KEYS as CATALOG_FRONTEND_SETTING_KEYS } from '@/lib/settings-catalog'
import type { AIProviderId } from '@/contracts/ai-provider'

export type { AIProviderId } from '@/contracts/ai-provider'
export type { WebhookConfig } from '@/contracts/webhook'

export interface ProviderConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export type ProviderConfigs = Record<AIProviderId, ProviderConfig>

export interface Settings extends Record<PromptBlockKey, string> {
  feishu_webhook_url: string
  push_mode: string
  push_time: string
  push_min_score: string
  push_min_relevance: string
  public_min_score: string
  public_hide_ads: string
  public_important_rule: string
  public_general_rule: string
  public_irrelevant_rule: string
  public_pin_hours: string
  crawl_interval_min: string
  ai_provider: string
  ai_temperature: string
  ai_max_tokens: string
  ai_system_prompt: string
  ai_weight_event: string
  ai_weight_content: string
  ai_step2_content_max_chars: string
}

export interface AiTestResult {
  success: boolean
  provider?: string
  model?: string
  error?: string
  responsePreview?: string
}

export interface WebhookTestResult {
  success: boolean
  error?: string
}

/**
 * 把保存的 Setting key 转成前端用的 Settings 字段（去除非前端 key）
 */
export const FRONTEND_SETTING_KEYS = CATALOG_FRONTEND_SETTING_KEYS as (keyof Settings)[]
