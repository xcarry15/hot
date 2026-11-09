import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const UNKNOWN = { region: '未知', city: '未知' };
let running = 0;
export function isVisitGeoConfigured(): boolean {
  return Boolean(process.env.VISIT_GEOIP_DB && existsSync(process.env.VISIT_GEOIP_DB) && (process.env.PATH || '').split(':').some((dir) => dir && existsSync(join(dir, 'mmdblookup'))));
}
/** Only uses an explicitly configured local database. Never sends IPs to an outside service. */
export async function lookupVisitRegion(ip: string): Promise<{ region: string; city: string }> {
  const file = process.env.VISIT_GEOIP_DB;
  if (!file || !isIP(ip) || running >= 4) return UNKNOWN;
  running++;
  try {
    const { stdout } = await exec('mmdblookup', ['--file', file, '--ip', ip], { timeout: 1200, maxBuffer: 32768 });
    // Support both standard GeoLite2 and the format used by the local panel database.
    const custom = (key: string) => new RegExp(`"${key}"\\s*:\\s*"([^"\\n]{1,80})"\\s*<utf8_string>`).exec(stdout)?.[1];
    const standard = (key: string) => new RegExp(`"${key}"\\s*:\\s*(?:\\[\\s*)?\\{[\\s\\S]*?"names"\\s*:\\s*\\{[\\s\\S]*?"(?:zh-CN|en)"\\s*:\\s*"([^"\\n]{1,80})"`).exec(stdout)?.[1];
    return { region: custom('province') || standard('subdivisions') || custom('country') || standard('country') || '未知', city: custom('city') || standard('city') || '未知' };
  } catch { return UNKNOWN; } finally { running--; }
}
