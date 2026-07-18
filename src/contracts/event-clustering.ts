export const EVENT_CLUSTER_WINDOW_DAYS = 7;
export const EVENT_CLUSTER_MAX_CANDIDATES = 5;
export const EVENT_CLUSTER_MAX_RETRIES = 5;
export const EVENT_CLUSTER_RULE_VERSION = 'event-cluster-v1';

export type ClusterStatus = 'pending' | 'clustered' | 'failed' | 'needs_review';

export function normalizeEventText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

export function buildCharacterNgrams(value: string, sizes: readonly number[] = [2, 3, 4]): Set<string> {
  const normalized = normalizeEventText(value);
  const grams = new Set<string>();
  for (const size of sizes) {
    for (let index = 0; index + size <= normalized.length; index++) {
      grams.add(normalized.slice(index, index + size));
    }
  }
  return grams;
}

export function overlapCoefficient(left: string, right: string): number {
  let best = 0;
  for (const size of [2, 3, 4] as const) {
    const a = buildCharacterNgrams(left, [size]);
    const b = buildCharacterNgrams(right, [size]);
    if (a.size === 0 || b.size === 0) continue;
    let intersection = 0;
    for (const gram of a) if (b.has(gram)) intersection++;
    best = Math.max(best, intersection / Math.min(a.size, b.size));
  }
  return best;
}

export function buildRuleEventKey(title: string): string {
  return normalizeEventText(title).slice(0, 160);
}
