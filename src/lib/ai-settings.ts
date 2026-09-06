import { createCache } from './cache';
import { readSettings, SETTING_KEYS } from './settings';
import { getSettingDefinition } from './settings-catalog';
import { PROMPT_VERSION_KEYS } from './prompts';
import {
  AI_PROVIDERS,
  isAIProviderId,
  isAIModelAllowed,
  providerSettingKey,
} from '@/contracts/ai-provider';
import type { AIProviderId } from '@/contracts/ai-provider';

export interface AIAnalysisPolicy {
  systemPrompt: string;
  /** 单次分析评判块（块化组合，空串=用默认块） */
  blockAd: string;
  blockEventScore: string;
  blockCategory: string;
  blockRelevance: string;
  blockContentScore: string;
  blockKeyPoints: string;
  blockSummary: string;
  blockEventIdentity: string;
  blockBrand: string;
  /** 打分权重(动态可调) */
  weightEvent: number;
  weightContent: number;
  keywordMatchBonus: number;
  /** AI 正文最大字符数 */
  step2ContentMaxChars: number;
}

export interface AISettings extends AIAnalysisPolicy {
  provider: AIProviderId;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/** 只包含本地评分所需配置，调用方不需要接触 Provider 凭据。 */
export interface AIScorePolicy {
  weightEvent: number;
  weightContent: number;
  keywordMatchBonus: number;
}

function numericSettingDefault(key: string, fallback: number): number {
  const value = Number(getSettingDefinition(key)?.defaultValue);
  return Number.isFinite(value) ? value : fallback;
}

// 默认值来自统一配置目录；fallback 只用于目录损坏时保持客户端可运行。
const DEFAULT_WEIGHT_EVENT = numericSettingDefault(SETTING_KEYS.AI_WEIGHT_EVENT, 70);
const DEFAULT_WEIGHT_CONTENT = numericSettingDefault(SETTING_KEYS.AI_WEIGHT_CONTENT, 30);
const DEFAULT_TEMPERATURE = numericSettingDefault(SETTING_KEYS.AI_TEMPERATURE, 0.3);
const DEFAULT_MAX_TOKENS = numericSettingDefault(SETTING_KEYS.AI_MAX_TOKENS, 2048);
const DEFAULT_STEP2_CONTENT_MAX_CHARS = numericSettingDefault(SETTING_KEYS.AI_STEP2_CONTENT_MAX_CHARS, 5000);

const settingsCache = createCache<AISettings>(30_000); // 30 seconds
const analysisPolicyCache = createCache<AIAnalysisPolicy>(30_000);
const scorePolicyCache = createCache<AIScorePolicy>(30_000);

const AI_ANALYSIS_SETTING_KEYS = [
  SETTING_KEYS.AI_STEP2_CONTENT_MAX_CHARS,
  ...PROMPT_VERSION_KEYS,
  SETTING_KEYS.AI_WEIGHT_EVENT,
  SETTING_KEYS.AI_WEIGHT_CONTENT,
  SETTING_KEYS.AI_KEYWORD_MATCH_BONUS,
] as const;

const AI_TRANSPORT_SETTING_KEYS = [
  SETTING_KEYS.AI_TEMPERATURE,
  SETTING_KEYS.AI_MAX_TOKENS,
] as const;

export function getAIProviderSettingKeys(provider: AIProviderId): readonly string[] {
  return [
    providerSettingKey(provider, 'api_key'),
    providerSettingKey(provider, 'base_url'),
    providerSettingKey(provider, 'model'),
  ];
}

async function readAISettingsMap(): Promise<Record<string, string>> {
  const common = await readSettings([
    SETTING_KEYS.AI_PROVIDER,
    ...AI_TRANSPORT_SETTING_KEYS,
    ...AI_ANALYSIS_SETTING_KEYS,
  ]);
  const defaultProvider = Object.keys(AI_PROVIDERS)[0] as AIProviderId;
  const requestedProvider = common[SETTING_KEYS.AI_PROVIDER];
  const provider: AIProviderId = requestedProvider && isAIProviderId(requestedProvider)
    ? requestedProvider as AIProviderId
    : defaultProvider;
  const providerKeys = getAIProviderSettingKeys(provider);
  const providerSettings = await readSettings(providerKeys);
  return {
    ...common,
    ...providerSettings,
  };
}

function clampWeight(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

function parseScorePolicy(map: Record<string, string>): AIScorePolicy {
  return {
    weightEvent: clampWeight(map[SETTING_KEYS.AI_WEIGHT_EVENT], DEFAULT_WEIGHT_EVENT),
    weightContent: clampWeight(map[SETTING_KEYS.AI_WEIGHT_CONTENT], DEFAULT_WEIGHT_CONTENT),
    keywordMatchBonus: Math.max(0, Math.min(20, parseInt(map[SETTING_KEYS.AI_KEYWORD_MATCH_BONUS]) || 0)),
  };
}

function parseAIAnalysisPolicy(map: Record<string, string>): AIAnalysisPolicy {
  return {
    systemPrompt: map[SETTING_KEYS.AI_SYSTEM_PROMPT],
    blockAd: map.ai_block_ad,
    blockEventScore: map.ai_block_event_score,
    blockCategory: map.ai_block_category,
    blockRelevance: map.ai_block_relevance,
    blockContentScore: map.ai_block_content_score,
    blockKeyPoints: map.ai_block_key_points,
    blockSummary: map.ai_block_summary,
    blockEventIdentity: map.ai_block_event_identity,
    blockBrand: map.ai_block_brand,
    ...parseScorePolicy(map),
    step2ContentMaxChars: Math.max(500, Math.min(10000, parseInt(map[SETTING_KEYS.AI_STEP2_CONTENT_MAX_CHARS]) || DEFAULT_STEP2_CONTENT_MAX_CHARS)),
  };
}

export async function getAISettings(): Promise<AISettings> {
  const cached = settingsCache.get();
  if (cached) return cached;

  const map = await readAISettingsMap();
  const requestedProvider = map[SETTING_KEYS.AI_PROVIDER];
  const defaultProvider = Object.keys(AI_PROVIDERS)[0] as AIProviderId;
  const provider: AIProviderId = requestedProvider && isAIProviderId(requestedProvider)
    ? requestedProvider as AIProviderId
    : defaultProvider;
  const providerDef = AI_PROVIDERS[provider];
  const rawTemperature = map[SETTING_KEYS.AI_TEMPERATURE]?.trim();
  const parsedTemperature = rawTemperature ? Number(rawTemperature) : Number.NaN;
  const temperature = Number.isFinite(parsedTemperature)
    ? Math.max(0, Math.min(2, parsedTemperature))
    : DEFAULT_TEMPERATURE;

  const apiKey = map[providerSettingKey(provider, 'api_key')] ?? '';
  const baseUrl = map[providerSettingKey(provider, 'base_url')] || providerDef.baseUrl;
  const configuredModel = map[providerSettingKey(provider, 'model')]?.trim() || providerDef.defaultModel;
  // 免费 Provider 只开放免费模型，防止旧数据库或手工写入的付费模型绕过设置页校验。
  const model = !isAIModelAllowed(provider, configuredModel)
    ? providerDef.defaultModel
    : configuredModel;

  const resolved: AISettings = {
    provider,
    apiKey,
    baseUrl,
    model,
    temperature,
    maxTokens: Math.max(1, Math.min(65536, parseInt(map[SETTING_KEYS.AI_MAX_TOKENS]) || DEFAULT_MAX_TOKENS)),
    ...parseAIAnalysisPolicy(map),
  };
  settingsCache.set(resolved);
  return resolved;
}

/** 文章流水线只读取分析策略，不加载任何 Provider 连接配置。 */
export async function getAIAnalysisPolicy(): Promise<AIAnalysisPolicy> {
  const cached = analysisPolicyCache.get();
  if (cached) return cached;
  const policy = parseAIAnalysisPolicy(await readSettings(AI_ANALYSIS_SETTING_KEYS));
  analysisPolicyCache.set(policy);
  return policy;
}

/** 读取评分策略的窄接口，避免评分重算解密或携带任何 API Key。 */
export async function getAIScorePolicy(): Promise<AIScorePolicy> {
  const cached = scorePolicyCache.get();
  if (cached) return cached;
  const policy = parseScorePolicy(await readSettings([
    SETTING_KEYS.AI_WEIGHT_EVENT,
    SETTING_KEYS.AI_WEIGHT_CONTENT,
    SETTING_KEYS.AI_KEYWORD_MATCH_BONUS,
  ]));
  scorePolicyCache.set(policy);
  return policy;
}

export function invalidateAISettingsCache(): void {
  settingsCache.invalidate();
  analysisPolicyCache.invalidate();
  scorePolicyCache.invalidate();
}
