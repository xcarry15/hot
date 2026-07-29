import { buildCanonicalEventKey, capEventIdentityConfidence, isCompleteEventIdentity, normalizeEventIdentity } from '@/contracts/event-identity';
import type { EventIdentity } from '@/contracts/event-identity';
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

function stripListMarker(value: string): string {
  return value
    .trim()
    .replace(/^(?:[-*•](?=\s|[^\d.])|\d{1,3}(?:[、)．]|\.(?!\d)))\s*/u, '')
    .trim();
}

function normalizeStringArray(value: unknown, maxItems: number, stripListMarkers = false): string[] {
  const decoded = decodeJsonArray(value);
  const values = Array.isArray(decoded)
    ? decoded
    : typeof decoded === 'string'
      ? decoded.split(/[|,，、\n]/)
      : [];
  return [...new Set(values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => stripListMarkers ? stripListMarker(item) : item.trim())
    .filter(Boolean))]
    .slice(0, maxItems);
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const FACTUAL_NON_AD_ACTION_PATTERN = /缴纳?(?:五险一金|社保|公积金)|提供?(?:五险一金|社保|公积金|职业伤害保障)|签署?劳动合同|员工福利|劳动保障|用工制度/u;

function normalizeAdDecision(input: {
  isAd: boolean;
  probability: number;
  eventScore: number;
  identity: { action: string; object: string };
  summary: string;
  keyPoints: string[];
}): { isAd: boolean; probability: number } {
  const factualText = [
    input.identity.action,
    input.identity.object,
    input.summary,
    ...input.keyPoints,
  ].join(' ');
  // 已验证的劳动保障/用工制度事实常因“由企业发布且对品牌有利”被误判。
  // 公益、救灾、辟谣等内容仍交给模型按文章核心目的判断，避免把品牌宣传
  // 仅凭一个事实关键词强制洗成非广告。
  if (input.isAd && input.eventScore >= 10 && FACTUAL_NON_AD_ACTION_PATTERN.test(factualText)) {
    return { isAd: false, probability: Math.min(input.probability, 19) };
  }
  return { isAd: input.isAd, probability: input.probability };
}

function legacyEventKeyParts(value: unknown): [unknown, unknown, unknown] {
  const parts = readText(value).split(/[|/]/u).map((item) => item.trim()).filter(Boolean);
  return [parts[0], parts[1], parts.slice(2).join(' ')];
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

/**
 * 兼容不同模型对同一结构的命名习惯，但不从 brand/summary 猜测身份。
 * 身份字段仍必须由模型明确返回，最终 eventKey 仍由程序生成。
 */
function readEventIdentity(raw: Record<string, unknown>): {
  identity: EventIdentity;
  confidence: number | null;
} {
  const nestedIdentity = readObject(firstDefined(raw.event_identity, raw.eventIdentity, raw.identity));
  const nestedEvent = readObject(raw.event);
  const [legacySubjects, legacyAction, legacyObject] = legacyEventKeyParts(
    firstDefined(raw.event_key, raw.eventKey, nestedIdentity.event_key, nestedIdentity.eventKey),
  );
  const explicitIdentity = normalizeEventIdentity({
    subjects: firstDefined(
      raw.event_subjects,
      raw.eventSubjects,
      raw.event_subject,
      raw.eventSubject,
      raw.subjects,
      raw.subject,
      raw['事件主体'],
      raw['主体'],
      nestedIdentity.event_subjects,
      nestedIdentity.eventSubjects,
      nestedIdentity.subjects,
      nestedIdentity.subject,
      nestedIdentity.actor,
      nestedEvent.event_subjects,
      nestedEvent.eventSubjects,
      nestedEvent.subjects,
      nestedEvent.subject,
      nestedEvent.actor,
    ),
    action: firstDefined(
      raw.event_action,
      raw.eventAction,
      raw.event_verb,
      raw.eventVerb,
      raw.action,
      raw.verb,
      raw['事件行为'],
      raw['行为'],
      nestedIdentity.event_action,
      nestedIdentity.eventAction,
      nestedIdentity.action,
      nestedIdentity.verb,
      nestedEvent.event_action,
      nestedEvent.eventAction,
      nestedEvent.action,
      nestedEvent.verb,
    ),
    object: firstDefined(
      raw.event_object,
      raw.eventObject,
      raw.event_matter,
      raw.eventMatter,
      raw.object,
      raw.matter,
      raw['具体事项'],
      raw['事项'],
      nestedIdentity.event_object,
      nestedIdentity.eventObject,
      nestedIdentity.event_matter,
      nestedIdentity.eventMatter,
      nestedIdentity.object,
      nestedIdentity.matter,
      nestedEvent.event_object,
      nestedEvent.eventObject,
      nestedEvent.object,
      nestedEvent.matter,
    ),
  });
  const identity = normalizeEventIdentity({
    subjects: explicitIdentity.subjects.length > 0 ? explicitIdentity.subjects : legacySubjects,
    action: explicitIdentity.action || legacyAction,
    object: explicitIdentity.object || legacyObject,
  });
  const rawConfidence = firstDefined(
    raw.event_key_confidence,
    raw.eventKeyConfidence,
    nestedIdentity.event_key_confidence,
    nestedIdentity.eventKeyConfidence,
    nestedIdentity.confidence,
  );
  return {
    identity,
    confidence: rawConfidence == null ? null : clampScore(rawConfidence),
  };
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

  const keyPoints = normalizeStringArray(raw.key_points ?? raw.keyPoints, 5, true);
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
  const { identity, confidence: identityConfidence } = readEventIdentity(raw);
  const eventScore = clampScore(raw.event_score ?? raw.eventScore);
  const normalizedAd = normalizeAdDecision({
    isAd,
    probability: raw.ad_probability == null && explicitIsAd !== null
      ? (explicitIsAd ? 100 : 0)
      : adProbability,
    eventScore,
    identity,
    summary,
    keyPoints,
  });
  // 事件影响力只描述事件大小，不能反推文章是否存在可聚类事实。
  // 单次调用中若身份不完整，清空身份而不是抛错重试；评分、摘要仍是有效分析结果。
  const hasCompleteEventIdentity = isCompleteEventIdentity(identity);
  const eventIdentity = hasCompleteEventIdentity
    ? identity
    : { subjects: [], action: '', object: '' };
  const eventKeyConfidence = hasCompleteEventIdentity
    ? capEventIdentityConfidence(identity, identityConfidence ?? 0)
    : 0;

  return {
    event_score: eventScore,
    content_score: clampScore(raw.content_score ?? raw.contentScore),
    relevance: clampScore(raw.relevance),
    is_ad: normalizedAd.isAd,
    ad_probability: normalizedAd.probability,
    confidence,
    category: (() => {
      const category = readText(raw.category);
      return CATEGORIES.has(category) ? category : '其他';
    })(),
    summary,
    brand,
    event_subjects: eventIdentity.subjects,
    event_action: eventIdentity.action,
    event_object: eventIdentity.object,
    event_key: buildCanonicalEventKey(eventIdentity),
    event_key_confidence: eventKeyConfidence,
    key_points: keyPoints,
  };
}
