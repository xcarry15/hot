import { describe, expect, it } from 'vitest';
import { parsePushMode, PUSH_MODES } from '@/contracts/push';

describe('PushMode contract', () => {
  it('只接受三个合法推送模式', () => {
    expect(PUSH_MODES).toEqual(['off', 'batch', 'realtime']);
    expect(parsePushMode('off')).toBe('off');
    expect(parsePushMode('batch')).toBe('batch');
    expect(parsePushMode('realtime')).toBe('realtime');
  });

  it('空值和非法值回退 realtime', () => {
    expect(parsePushMode('')).toBe('realtime');
    expect(parsePushMode(undefined)).toBe('realtime');
    expect(parsePushMode('invalid')).toBe('realtime');
  });
});
