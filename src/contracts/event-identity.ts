export const EVENT_SUBJECT_MAX_ITEMS = 3;
export const EVENT_SUBJECT_MAX_LENGTH = 16;
export const EVENT_ACTION_MAX_LENGTH = 8;
export const EVENT_OBJECT_MAX_LENGTH = 16;
export const EVENT_KEY_MAX_LENGTH = 256;

export interface EventIdentity {
  subjects: string[];
  action: string;
  object: string;
}

function cleanComponent(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[|/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeIdentityToken(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

const ACTION_CANONICAL_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:计划|拟|预计|筹备|将).*?(?:开业|开店|首店|门店)/u, '计划开店'],
  [/(?:正式|已|已经|开出|首店落地).*?(?:开业|开店|首店|门店)/u, '正式开店'],
  [/(?:开业|开店|首店|门店落地)/u, '开店'],
  [/(?:计划|拟|预计|将).*?(?:关闭|关店|闭店|关停|撤店|撤场)/u, '计划关店'],
  [/(?:关闭|关店|闭店|关停|撤店|撤场)/u, '关闭门店'],
  [/(?:任命|换帅|接任|出任|履新).*?(?:董事长|CEO|总裁|高管|负责人)?/u, '任命高管'],
  [/(?:离职|卸任|辞任|离开).*?(?:董事长|CEO|总裁|高管|负责人)?/u, '高管离任'],
  [/(?:增持|加仓).*?(?:股份|股票|持股)?/u, '增持股份'],
  [/(?:减持|减仓).*?(?:股份|股票|持股)?/u, '减持股份'],
  [/(?:财报|业绩|营收|利润|经营数据|业务前瞻)/u, '发布业绩'],
  [/(?:IPO|上市)/iu, 'IPO上市'],
  [/(?:融资|募资)/u, '融资'],
  [/(?:收购|并购|兼并)/u, '完成收购'],
  [/(?:合作|联手|签约|战略协议)/u, '启动合作'],
  [/(?:上线|推出|发布).*?(?:功能|服务|系统)/u, '上线功能'],
  [/(?:发布|推出|上新).*?(?:产品|新品|品牌)/u, '发布产品'],
  [/(?:涨价|提价)/u, '价格上涨'],
  [/(?:降价|降费)/u, '价格下调'],
  [/(?:处罚|罚款|监管|约谈|通报)/u, '监管处置'],
  [/(?:维权|起诉|投诉|争议)/u, '争议维权'],
  [/(?:捐赠|驰援|救援|备灾)/u, '捐赠救援'],
  [/(?:获奖|荣获|夺冠)/u, '获得奖项'],
];

const VAGUE_ACTION_PATTERN = /布局|升级|发力|加码|推进|深化|探索|调整|应对|打造|构建|聚焦|优化|转型|发展|战略|经营重心/u;
const MULTI_ACTION_PATTERN = /并|同时|以及|及/u;
const VAGUE_OBJECT_PATTERN = /^(?:行业趋势|发展方向|战略布局|竞争压力|经营模式|市场变化|业务增长)$/u;

/**
 * 把模型容易写成同义长句的动作压缩为稳定的事件动作。
 * 周年庆、趋势判断等没有明确动作的内容保留原文，避免误归一化。
 */
export function normalizeEventAction(value: unknown): string {
  const action = cleanComponent(value, 80);
  if (!action || /周年|纪念|回顾|趋势|预测/u.test(action)) return action.slice(0, EVENT_ACTION_MAX_LENGTH);
  for (const [pattern, canonical] of ACTION_CANONICAL_RULES) {
    if (pattern.test(action)) return canonical;
  }
  return action.slice(0, EVENT_ACTION_MAX_LENGTH);
}

/** 宽泛身份不允许以高置信度参与强聚类，避免泛主题污染 Event。 */
export function capEventIdentityConfidence(identity: EventIdentity, confidence: number): number {
  let cap = 100;
  if (VAGUE_ACTION_PATTERN.test(identity.action) || MULTI_ACTION_PATTERN.test(identity.action)) cap = 60;
  if (identity.object.length < 4 || VAGUE_OBJECT_PATTERN.test(identity.object)) cap = Math.min(cap, 60);
  return Math.min(Math.max(0, Math.round(confidence)), cap);
}

function decodeArray(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function normalizeEventSubjects(value: unknown): string[] {
  const decoded = decodeArray(value);
  const values = Array.isArray(decoded)
    ? decoded
    : typeof decoded === 'string'
      ? decoded.split(/[+|/、,，;；\n]/u)
      : [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const subject = cleanComponent(value, EVENT_SUBJECT_MAX_LENGTH);
    const token = normalizeIdentityToken(subject);
    if (!subject || !token || seen.has(token)) continue;
    seen.add(token);
    result.push(subject);
    if (result.length >= EVENT_SUBJECT_MAX_ITEMS) break;
  }
  return result;
}

/**
 * 连锁消费场景优先使用已提取的品牌作为事件主体，保证品牌字段与事件键只有一套真相。
 * 无明确品牌的事件（如监管、人事或行业事件）才退回模型提取的直接主体。
 */
export function resolveEventKeySubjects(brand: unknown, fallback: unknown): string[] {
  const brandSubjects = normalizeEventSubjects(brand);
  return brandSubjects.length > 0 ? brandSubjects : normalizeEventSubjects(fallback);
}

export function normalizeEventIdentity(input: {
  subjects: unknown;
  action: unknown;
  object: unknown;
}): EventIdentity {
  return {
    subjects: normalizeEventSubjects(input.subjects),
    action: normalizeEventAction(input.action),
    object: cleanComponent(input.object, EVENT_OBJECT_MAX_LENGTH),
  };
}

export function isCompleteEventIdentity(identity: EventIdentity): boolean {
  return identity.subjects.length > 0 && Boolean(identity.action) && Boolean(identity.object);
}

export function buildCanonicalEventKey(identity: EventIdentity): string {
  if (!isCompleteEventIdentity(identity)) return '';
  const subjects = [...identity.subjects].sort((left, right) => {
    const leftToken = normalizeIdentityToken(left);
    const rightToken = normalizeIdentityToken(right);
    return leftToken < rightToken ? -1 : leftToken > rightToken ? 1 : 0;
  });
  return `${subjects.join('+')}/${identity.action}/${identity.object}`.slice(0, EVENT_KEY_MAX_LENGTH);
}

export function serializeEventSubjects(subjects: readonly string[]): string {
  return JSON.stringify(normalizeEventSubjects([...subjects]));
}

export function parseEventSubjects(value: string | null | undefined): string[] {
  return normalizeEventSubjects(value ?? '[]');
}
