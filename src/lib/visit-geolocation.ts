import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const UNKNOWN = { region: '未知', city: '未知' };
const CACHE_LIMIT = 512;
const CACHE_TTL_MS = 10 * 60 * 1000;
let running = 0;
const cache = new Map<string, { value: { region: string; city: string }; at: number }>();
const warnedReasons = new Set<string>();

export function isVisitGeoConfigured(): boolean {
  return Boolean(process.env.VISIT_GEOIP_DB && existsSync(process.env.VISIT_GEOIP_DB) && (process.env.PATH || '').split(':').some((dir) => dir && existsSync(join(dir, 'mmdblookup'))));
}

function warnOnce(reason: string, message: string): void {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  console.warn(`[visit-geolocation] ${message}`);
}

function lookupFromCache(ip: string, now: number): { region: string; city: string } | undefined {
  const hit = cache.get(ip);
  if (!hit) return undefined;
  if (now - hit.at > CACHE_TTL_MS) { cache.delete(ip); return undefined; }
  hit.at = now; // LRU：命中即刷新，避免热点 IP 被先挤出
  return hit.value;
}

function remember(ip: string, value: { region: string; city: string }, now: number): void {
  if (cache.size >= CACHE_LIMIT) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, entry] of cache) {
      if (entry.at < oldestAt) { oldestAt = entry.at; oldestKey = key; }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(ip, { value, at: now });
}

/** Only uses an explicitly configured local database. Never sends IPs to an outside service. */
export async function lookupVisitRegion(ip: string): Promise<{ region: string; city: string }> {
  const now = Date.now();
  const cached = lookupFromCache(ip, now);
  if (cached) return cached;

  const file = process.env.VISIT_GEOIP_DB;
  if (!file || !existsSync(file)) {
    warnOnce('unconfigured', 'VISIT_GEOIP_DB 未配置或文件不存在；地区统计将返回“未知”');
    return UNKNOWN;
  }
  if (!isIP(ip)) return UNKNOWN;
  if (running >= 4) {
    warnOnce('concurrency', '并发查询达到上限（4），本次地区解析降级为“未知”');
    return UNKNOWN;
  }

  running++;
  try {
    const { stdout } = await exec('mmdblookup', ['--file', file, '--ip', ip], { timeout: 1200, maxBuffer: 32768 });
    // Support both standard GeoLite2 and the format used by the local panel database.
    const custom = (key: string) => new RegExp(`"${key}"\\s*:\\s*"([^"\\n]{1,80})"\\s*<utf8_string>`).exec(stdout)?.[1];
    const standard = (key: string) => new RegExp(`"${key}"\\s*:\\s*(?:\\[\\s*)?\\{[\\s\\S]*?"names"\\s*:\\s*\\{[\\s\\S]*?"(?:zh-CN|en)"\\s*:\\s*"([^"\\n]{1,80})"`).exec(stdout)?.[1];
    const value = { region: custom('province') || standard('subdivisions') || custom('country') || standard('country') || '未知', city: custom('city') || standard('city') || '未知' };
    // 只缓存解析成功的结果，避免把偶发降级后的“未知”长期固化。
    if (value.region !== '未知' || value.city !== '未知') remember(ip, value, now);
    return value;
  } catch (error) {
    warnOnce('lookup-error', `mmdblookup 查询失败，地区统计降级为“未知”：${error instanceof Error ? error.message : 'unknown error'}`);
    return UNKNOWN;
  } finally { running--; }
}
