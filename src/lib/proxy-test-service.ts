import { isIP } from 'node:net';
import { fetchSafe, readResponseText } from '@/lib/http';
import { withTimeout } from '@/lib/shared/async';
import {
  proxyUrlSchema,
  type ProxyBatchTestResult,
  type ProxyCandidate,
  type ProxyTestResult,
} from '@/contracts/proxy';
import { isBlockedOutboundHostname } from '@/lib/outbound-url';

const PROXY_TEST_TARGET = 'https://news.winshang.com/list-12.html';
const PROXY_TEST_TIMEOUT_MS = 8_000;
const PROXY_TEST_MAX_RESPONSE_BYTES = 128 * 1024;

// 这些节点曾经在本项目中实际访问赢商网成功。动态公开列表里的节点
// 变化很快，不能因为发布/重启就把一组已验证过的兜底节点丢掉；它们仍需
// 每次按当前目标重新测速，不能直接视为永久可用。
const HISTORICAL_FREE_PROXY_CANDIDATES: ProxyCandidate[] = [
  { url: 'http://112.64.135.45:8080', label: '历史可用节点 #1' },
  { url: 'http://116.196.150.180:17981', label: '历史可用节点 #2' },
  { url: 'http://120.232.115.170:17981', label: '历史可用节点 #3' },
  { url: 'http://122.246.3.12:17981', label: '历史可用节点 #4' },
  { url: 'http://122.246.4.6:17981', label: '历史可用节点 #5' },
  { url: 'http://58.254.153.146:17981', label: '历史可用节点 #6' },
];

// 这些列表只作为候选来源，实际是否可用仍以本项目对目标站点的测速结果为准。
// RelayGlass 和 Proxifly 的 HTTPS 文件优先；TheSpeedX 作为额外的 HTTP 兜底来源。
const FREE_PROXY_SOURCES = [
  {
    label: 'RelayGlass HTTPS',
    url: 'https://raw.githubusercontent.com/relayglass/free-proxy-list/main/protocol/https/https.txt',
  },
  {
    label: 'Proxifly HTTPS',
    url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/https/data.txt',
  },
  {
    label: 'TheSpeedX HTTP',
    url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  },
] as const;

const FREE_PROXY_CACHE_TTL_MS = 5 * 60_000;
const FREE_PROXY_SOURCE_TIMEOUT_MS = 8_000;
const FREE_PROXY_SOURCE_MAX_RESPONSE_BYTES = 512 * 1024;
const FREE_PROXY_SOURCE_LIMIT = 12;
const FREE_PROXY_CANDIDATE_LIMIT = 24;
const BATCH_TEST_CONCURRENCY = 6;

interface ProxyCandidateSnapshot {
  candidates: ProxyCandidate[];
  sourceCount: number;
  sourceErrors: string[];
}

interface ProxySourceResult {
  source: (typeof FREE_PROXY_SOURCES)[number];
  candidates: string[];
  error?: string;
}

let cachedCandidates: ProxyCandidateSnapshot | null = null;
let cachedAt = 0;
let loadingCandidates: Promise<ProxyCandidateSnapshot> | null = null;
let testingCandidates: Promise<ProxyBatchTestResult> | null = null;

/** 测试代理是否能访问实际需要抓取的公开页面，不发送项目密钥或业务内容。 */
export async function testOutboundProxy(rawProxyUrl: unknown): Promise<ProxyTestResult> {
  const parsed = proxyUrlSchema.safeParse(rawProxyUrl);
  if (!parsed.success || !parsed.data) {
    return { success: false, error: parsed.success ? '请先填写代理地址' : parsed.error.issues[0]?.message || '代理地址无效' };
  }

  const startedAt = Date.now();
  let response: Response | undefined;
  try {
    const outcome = await withTimeout(
      async (signal) => {
        const nextResponse = await fetchSafe(PROXY_TEST_TARGET, {
          signal,
          proxyUrl: parsed.data,
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'Mozilla/5.0 (compatible; hot2 proxy test)',
          },
        });
        response = nextResponse;
        if (!nextResponse.ok) return { response: nextResponse, body: '' };
        return {
          response: nextResponse,
          body: await readResponseText(nextResponse, PROXY_TEST_MAX_RESPONSE_BYTES),
        };
      },
      PROXY_TEST_TIMEOUT_MS,
      '代理连通性测试超时',
    );
    const latencyMs = Date.now() - startedAt;
    if (!outcome.response.ok) {
      await cancelResponseBody(outcome.response);
      return { success: false, status: outcome.response.status, latencyMs, error: `目标页面返回 HTTP ${outcome.response.status}` };
    }
    if (!outcome.body.trim()) {
      await cancelResponseBody(outcome.response);
      return { success: false, status: outcome.response.status, latencyMs, error: '代理返回了空页面' };
    }
    return { success: true, status: outcome.response.status, latencyMs };
  } catch (error) {
    await cancelResponseBody(response);
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : '';
    return {
      success: false,
      latencyMs,
      error: /timeout|aborted|aborterror/i.test(message)
        ? '代理连接超时，请更换节点或检查端口'
        : '代理连接失败，请检查地址、端口或节点是否可用',
    };
  }
}

/** 清除免费候选缓存；仅用于用户主动刷新或测试隔离。 */
export function invalidateFreeProxyCache(): void {
  cachedCandidates = null;
  cachedAt = 0;
}

/** 读取并整理公开列表，进程内短时缓存，避免每次点击都请求外部列表。 */
export async function getFreeProxyCandidates(forceRefresh = false): Promise<ProxyCandidateSnapshot> {
  if (!forceRefresh && cachedCandidates && Date.now() - cachedAt < FREE_PROXY_CACHE_TTL_MS) {
    return cachedCandidates;
  }
  if (loadingCandidates) return loadingCandidates;

  const loading = Promise.all(FREE_PROXY_SOURCES.map(fetchProxySource))
    .then((sourceResults) => {
      const successfulSources = sourceResults.filter((result) => result.candidates.length > 0);
      const seen = new Set<string>();
      const candidates: ProxyCandidate[] = [];
      for (const candidate of HISTORICAL_FREE_PROXY_CANDIDATES) {
        seen.add(candidate.url);
        candidates.push(candidate);
      }
      for (let index = 0; candidates.length < FREE_PROXY_CANDIDATE_LIMIT; index++) {
        let hasSourceCandidate = false;
        for (const result of successfulSources) {
          const url = result.candidates[index];
          if (!url) continue;
          hasSourceCandidate = true;
          if (seen.has(url)) continue;
          seen.add(url);
          candidates.push({ url, label: `${result.source.label} #${index + 1}` });
          if (candidates.length >= FREE_PROXY_CANDIDATE_LIMIT) break;
        }
        if (!hasSourceCandidate) break;
      }

      return {
        candidates,
        sourceCount: successfulSources.length,
        sourceErrors: sourceResults
          .filter((result) => result.error)
          .map((result) => result.error!),
      };
    })
    .then((snapshot) => {
      const previousCandidates = cachedCandidates;
      const fallback = snapshot.candidates.length === 0 && previousCandidates?.candidates.length
        ? {
          ...previousCandidates,
          sourceErrors: [...new Set([...snapshot.sourceErrors, '实时列表读取失败，沿用上次候选'])],
        }
        : snapshot;
      cachedCandidates = fallback;
      cachedAt = Date.now();
      return fallback;
    })
    .finally(() => {
      loadingCandidates = null;
    });

  loadingCandidates = loading;
  return loading;
}

/** 并发测试最新免费候选，并返回成功节点中延迟最低的节点。 */
export async function testOutboundProxies(forceRefresh = false): Promise<ProxyBatchTestResult> {
  if (testingCandidates) return testingCandidates;
  const testing = runOutboundProxyBatch(forceRefresh).finally(() => {
    testingCandidates = null;
  });
  testingCandidates = testing;
  return testing;
}

async function runOutboundProxyBatch(forceRefresh: boolean): Promise<ProxyBatchTestResult> {
  const snapshot = await getFreeProxyCandidates(forceRefresh);
  const results: ProxyBatchTestResult['results'] = [];
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      const candidate = snapshot.candidates[index];
      if (!candidate) return;
      const result = await testOutboundProxy(candidate.url);
      results[index] = { ...result, ...candidate };
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(BATCH_TEST_CONCURRENCY, snapshot.candidates.length) }, () => worker()),
  );

  const orderedResults = snapshot.candidates
    .map((_, index) => results[index])
    .filter((result): result is ProxyBatchTestResult['results'][number] => Boolean(result));
  const fastest = orderedResults
    .filter((result) => result.success && typeof result.latencyMs === 'number')
    .reduce<ProxyBatchTestResult['results'][number] | undefined>(
      (current, result) => {
        if (!current) return result;
        return (current.latencyMs ?? Infinity) <= (result.latencyMs ?? Infinity) ? current : result;
      },
      undefined,
    );

  return {
    results: orderedResults,
    fastestUrl: fastest?.success ? fastest.url : undefined,
    sourceCount: snapshot.sourceCount,
    sourceErrors: snapshot.sourceErrors,
  };
}

async function fetchProxySource(source: (typeof FREE_PROXY_SOURCES)[number]): Promise<ProxySourceResult> {
  let response: Response | undefined;
  try {
    const text = await withTimeout(
      async (signal) => {
        const nextResponse = await fetchSafe(source.url, {
          signal,
          bypassProxy: true,
          headers: { Accept: 'text/plain', 'User-Agent': 'hot2 free-proxy-list reader' },
        });
        response = nextResponse;
        if (!nextResponse.ok) {
          await cancelResponseBody(nextResponse);
          throw new Error(`HTTP ${nextResponse.status}`);
        }
        return readResponseText(nextResponse, FREE_PROXY_SOURCE_MAX_RESPONSE_BYTES);
      },
      FREE_PROXY_SOURCE_TIMEOUT_MS,
      `${source.label} 列表读取超时`,
    );
    const candidates = parseProxyList(text);
    return {
      source,
      candidates,
      error: candidates.length === 0 ? `${source.label} 没有可用候选` : undefined,
    };
  } catch (error) {
    await cancelResponseBody(response);
    const message = error instanceof Error ? error.message : String(error);
    return { source, candidates: [], error: `${source.label} 列表读取失败：${summarizeProxyError(message)}` };
  }
}

function summarizeProxyError(message: string): string {
  if (/^HTTP \d{3}(?:\b|$)/i.test(message)) return message;
  if (/timeout|timed out|aborted|aborterror/i.test(message)) return '请求超时';
  return message.replace(/\s+/g, ' ').slice(0, 120) || '网络请求失败';
}

async function cancelResponseBody(response: Response | undefined): Promise<void> {
  try {
    await response?.body?.cancel();
  } catch {
    // 连接已经被超时或代理关闭时，清理失败不应影响其他节点的测速。
  }
}

function parseProxyList(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const token = line.trim().split(/\s+/)[0]?.replace(/[;,]$/, '');
    if (!token || token.startsWith('#')) continue;

    const rawUrl = token.includes('://') ? token : `http://${token}`;
    try {
      const parsed = new URL(rawUrl);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        || parsed.username
        || parsed.password
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash
        || isIP(parsed.hostname) !== 4
        || isBlockedOutboundHostname(parsed.hostname)) continue;

      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      const normalized = `${parsed.protocol}//${parsed.hostname}:${port}`;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      candidates.push(normalized);
      if (candidates.length >= FREE_PROXY_SOURCE_LIMIT) break;
    } catch {
      // 公开列表偶尔混有标题、注释或损坏行，跳过单行即可。
    }
  }
  return candidates;
}
