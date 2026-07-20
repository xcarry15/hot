import { buildCanonicalEventKey, isCompleteEventIdentity, normalizeEventIdentity } from '@/contracts/event-identity';
import { extractJsonObject } from './ai-helpers';

const CATEGORIES = new Set([
  '餐饮', '零售', '品牌', '加盟', '食品', '供应链', '政策', '资本',
  '消费者', '科技', '人事', '其他',
]);

export interface AiAnalysisOutput {
  event_score: number;
  content_score: number;
  relevance: number;
  is_ad: boolean;
  ad_probability: number;
  confidence: number;
  category: string;
  summary: string;
  brand: string[];
  event_subjects: string[];
  event_action: string;
  event_object: string;
  event_key: string;
  event_key_confidence: number;
  key_points: string[];
}

function clampScore(value: unknown, fallback = 0): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.replace(/[分%％]/g, '').trim())
      : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  if (/^(true|是|广告|软文)$/i.test(value.trim())) return true;
  if (/^(false|否|非广告|正常)$/i.test(value.trim())) return false;
  return null;
}

function decodeJsonArray(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeStringArray(value: unknown, maxItems: number): string[] {
  const decoded = decodeJsonArray(value);
  const values = Array.isArray(decoded)
    ? decoded
    : typeof decoded === 'string'
      ? decoded.split(/[|,，、\n]/)
      : [];
  return [...new Set(values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/^[-*•\d.、)]+\s*/, '').trim())
    .filter(Boolean))]
    .slice(0, maxItems);
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function legacyEventKeyParts(value: unknown): [unknown, unknown, unknown] {
  const parts = readText(value).split(/[|/]/u).map((item) => item.trim()).filter(Boolean);
  return [parts[0], parts[1], parts.slice(2).join(' ')];
}

/**
 * 结构化 AI 分析结果的唯一入口。
 *
 * 模型输出的长度、数组格式和数字类型存在自然波动，不能把这些表达差异
 * 当成整篇分析失败。这里只对 JSON、核心字段和数值范围做保护，其余内容
 * 统一归一化后落库；真正没有可用 JSON/评分字段时才让上层进入失败重试。
 */
export function parseAiAnalysisOutput(text: string): AiAnalysisOutput {
  const raw = extractJsonObject(text);
  const hasCoreScore = [
    ['event_score', 'eventScore'],
    ['content_score', 'contentScore'],
    ['relevance'],
  ].every((keys) => keys.some((key) => key in raw));
  if (!hasCoreScore) throw new Error('LLM 响应缺少核心评分字段');

  const keyPoints = normalizeStringArray(raw.key_points ?? raw.keyPoints, 5);
  const summary = readText(raw.summary ?? raw.insight ?? raw.overview)
    .replace(/\s+/g, ' ')
    .slice(0, 600)
    || keyPoints.join('；').slice(0, 600);
  if (!summary) throw new Error('LLM 响应缺少可用洞察');

  const hasAdProbability = raw.ad_probability != null || raw.adProbability != null;
  const adProbability = clampScore(raw.ad_probability ?? raw.adProbability);
  const explicitIsAd = readBoolean(raw.is_ad ?? raw.isAd);
  const isAd = hasAdProbability ? adProbability >= 50 : (explicitIsAd ?? false);

  const confidence = clampScore(raw.confidence);
  const brand = normalizeStringArray(raw.brand ?? raw.brands, 2);
  const nestedIdentity = readObject(raw.event_identity ?? raw.eventIdentity);
  const [legacySubjects, legacyAction, legacyObject] = legacyEventKeyParts(raw.event_key ?? raw.eventKey);
  const explicitIdentity = normalizeEventIdentity({
    subjects: raw.event_subjects
      ?? raw.eventSubjects
      ?? nestedIdentity.subjects
      ?? nestedIdentity.subject,
    action: raw.event_action
      ?? raw.eventAction
      ?? nestedIdentity.action
      ?? '',
    object: raw.event_object
      ?? raw.eventObject
      ?? nestedIdentity.object
      ?? nestedIdentity.matter
      ?? '',
  });
  const identity = normalizeEventIdentity({
    subjects: explicitIdentity.subjects.length > 0 ? explicitIdentity.subjects : legacySubjects ?? brand,
    action: explicitIdentity.action || legacyAction,
    object: explicitIdentity.object || legacyObject,
  });
  if (!isCompleteEventIdentity(identity)) {
    throw new Error('LLM 响应缺少完整事件身份（主体/行为/具体事项）');
  }

  return {
    event_score: clampScore(raw.event_score ?? raw.eventScore),
    content_score: clampScore(raw.content_score ?? raw.contentScore),
    relevance: clampScore(raw.relevance),
    is_ad: isAd,
    ad_probability: raw.ad_probability == null && explicitIsAd !== null
      ? (explicitIsAd ? 100 : 0)
      : adProbability,
    confidence,
    category: (() => {
      const category = readText(raw.category);
      return CATEGORIES.has(category) ? category : '其他';
    })(),
    summary,
    brand,
    event_subjects: identity.subjects,
    event_action: identity.action,
    event_object: identity.object,
    event_key: buildCanonicalEventKey(identity),
    event_key_confidence: clampScore(
      raw.event_key_confidence
        ?? raw.eventKeyConfidence
        ?? nestedIdentity.confidence,
      confidence,
    ),
    key_points: keyPoints,
  };
}
