import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);

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
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true;
  const mappedV4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return Boolean(mappedV4 && isPrivateIpv4(mappedV4[1]));
}

export function isBlockedOutboundHostname(hostname: string): boolean {
  const normalized = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!normalized || BLOCKED_HOSTNAMES.has(normalized) || normalized.endsWith('.localhost')) return true;
  const family = isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family === 6) return isPrivateIpv6(normalized);
  return false;
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
