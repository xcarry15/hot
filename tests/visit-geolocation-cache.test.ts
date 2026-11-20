import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }));

import { isVisitGeoConfigured, lookupVisitRegion } from '@/lib/visit-geolocation';

const GEO = '/tmp/GeoLite2-City.mmdb';

afterEach(() => { vi.resetAllMocks(); });

function geoOutput(region: string, city: string) {
  return `"province": "${region}" <utf8_string>\n"city": "${city}" <utf8_string>`;
}

describe('visit geolocation cache & fallback', () => {
  it('配置完整时报告已配置', () => {
    process.env.VISIT_GEOIP_DB = GEO;
    mocks.existsSync.mockImplementation((p: string) => p === GEO || String(p).endsWith('/mmdblookup'));
    const originalPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    expect(isVisitGeoConfigured()).toBe(true);
    process.env.PATH = originalPath;
  });

  it('相同 IP 命中缓存，不重复调用 mmdblookup', async () => {
    process.env.VISIT_GEOIP_DB = GEO;
    mocks.existsSync.mockReturnValue(true);
    mocks.execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: null, r: {stdout: string}) => void) => {
      cb(null, { stdout: geoOutput('广东省', '深圳市') });
    });
    const first = await lookupVisitRegion('1.2.3.4');
    const second = await lookupVisitRegion('1.2.3.4');
    expect(first).toEqual({ region: '广东省', city: '深圳市' });
    expect(second).toEqual(first);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('不同 IP 各自解析', async () => {
    process.env.VISIT_GEOIP_DB = GEO;
    mocks.existsSync.mockReturnValue(true);
    mocks.execFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (e: null, r: {stdout: string}) => void) => {
      const ip = args[args.length - 1];
      cb(null, { stdout: geoOutput(ip === '1.1.1.1' ? '北京市' : '上海市', '某市') });
    });
    expect((await lookupVisitRegion('1.1.1.1')).region).toBe('北京市');
    expect((await lookupVisitRegion('2.2.2.2')).region).toBe('上海市');
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it('未配置 mmdb 时降级为未知且不调用外部命令', async () => {
    delete process.env.VISIT_GEOIP_DB;
    const result = await lookupVisitRegion('8.8.8.8');
    expect(result).toEqual({ region: '未知', city: '未知' });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
