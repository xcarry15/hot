import { lookup as lookupDns } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupOptions } from 'node:dns';
import { Agent, interceptors } from 'undici';

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);

type SafeDnsStorage = NonNullable<NonNullable<Parameters<typeof interceptors.dns>[0]>['storage']>;
const safeDnsRecords = new Map<string, NonNullable<ReturnType<SafeDnsStorage['get']>>>();
const safeDnsStorage: SafeDnsStorage = {
  get(origin) {
    return safeDnsRecords.get(origin) ?? null;
  },
  set(origin, records) {
    if (!records) {
      safeDnsRecords.delete(origin);
      return;
    }
    if (!safeDnsRecords.has(origin) && safeDnsRecords.size >= 100) {
      const oldest = safeDnsRecords.keys().next().value as string | undefined;
      if (oldest) safeDnsRecords.delete(oldest);
    }
    safeDnsRecords.set(origin, records);
  },
  delete(origin) {
    safeDnsRecords.delete(origin);
  },
  full: () => false,
  get size() {
    return safeDnsRecords.size;
  },
};

/**
 * Native fetch 的 DNS 解析发生在 assertSafeOutboundUrl 之后，单次解析检查
 * 仍可能被 DNS rebinding 绕过。把同一策略挂到 Undici 的连接级 lookup，
 * 确保真正建立 socket 时使用的每个地址都经过内网拦截。
 */
const safeOutboundDispatcher = new Agent({ maxOrigins: 100 }).compose(
  interceptors.dns({
    maxTTL: 1,
    maxItems: 100,
    dualStack: true,
    storage: safeDnsStorage,
    lookup: (hostname: string | URL, _options: LookupOptions, callback: (error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: 4 | 6; ttl: number }>) => void) => {
      const name = typeof hostname === 'string' ? hostname : hostname.hostname;
      lookupDns(name, { all: true, verbatim: true }, (error, addresses) => {
        if (error) {
          callback(error, []);
          return;
        }
        const records = addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6, ttl: 0 }));
        if (records.length === 0 || records.some((entry) => isBlockedOutboundHostname(entry.address))) {
          const blockedError = new Error('出站地址解析到受限网络') as NodeJS.ErrnoException;
          blockedError.code = 'EOUTBOUNDPRIVATE';
          callback(blockedError, []);
          return;
        }
        callback(null, records);
      });
    },
  }),
);

function isPrivateIpv4(value: string): boolean {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isPrivateIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  const groups = expandIpv6(normalized);
  if (!groups) return true;

  const isUnspecified = groups.every((group) => group === 0);
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const first = groups[0];
  const isUniqueLocal = (first & 0xfe00) === 0xfc00;
  // fe80::/10 is fe80-febf, not only the single fe80::/16 prefix.
  const isLinkLocal = (first & 0xffc0) === 0xfe80;
  const isMulticast = (first & 0xff00) === 0xff00;
  if (isUnspecified || isLoopback || isUniqueLocal || isLinkLocal || isMulticast) return true;

  // IPv4-mapped IPv6 addresses must use the IPv4 policy as well, including
  // hexadecimal forms such as ::ffff:7f00:1.
  const isMappedIpv4 = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isMappedIpv4) {
    const high = groups[6];
    const low = groups[7];
    const mapped = `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
    return isPrivateIpv4(mapped);
  }

  // IPv4-compatible IPv6（::/96，已废弃但仍可能被解析器返回）同样代表
  // 一个 IPv4 地址，不能因为没有 ::ffff 前缀而绕过内网地址策略。
  const isIpv4Compatible = groups.slice(0, 6).every((group) => group === 0);
  if (isIpv4Compatible) {
    const high = groups[6];
    const low = groups[7];
    const mapped = `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
    return isPrivateIpv4(mapped);
  }
  return false;
}

function expandIpv6(value: string): number[] | null {
  const withoutZone = value.split('%', 1)[0];
  const parts = withoutZone.split('::');
  if (parts.length > 2) return null;

  const expandPart = (part: string): number[] | null => {
    if (!part) return [];
    const tokens = part.split(':');
    const groups: number[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.includes('.')) {
        if (index !== tokens.length - 1) return null;
        const octets = token.split('.').map(Number);
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      groups.push(Number.parseInt(token, 16));
    }
    return groups;
  };

  const left = expandPart(parts[0]);
  const right = expandPart(parts[1] ?? '');
  if (!left || !right) return null;
  if (parts.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

export function isBlockedOutboundHostname(hostname: string): boolean {
  const normalized = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!normalized || BLOCKED_HOSTNAMES.has(normalized) || normalized.endsWith('.localhost')) return true;
  const family = isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family === 6) return isPrivateIpv6(normalized);
  return false;
}

export function getSafeOutboundDispatcher(): typeof safeOutboundDispatcher {
  return safeOutboundDispatcher;
}

/**
 * 校验服务器出站地址。来源配置阶段做静态主机拦截；实际请求阶段再解析 DNS，
 * 并在每一次重定向后重新检查，阻断内网/云元数据 SSRF。
 */
export async function assertSafeOutboundUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅允许 http/https 出站地址');
  }
  if (url.username || url.password || isBlockedOutboundHostname(url.hostname)) {
    throw new Error('出站地址指向受限主机');
  }

  // 单测不做真实 DNS；生产和开发环境都校验解析后的所有地址。
  if (process.env.NODE_ENV !== 'test') {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some((entry) => isBlockedOutboundHostname(entry.address))) {
      throw new Error('出站地址解析到受限网络');
    }
  }
  return url;
}
