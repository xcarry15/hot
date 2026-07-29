import { describe, expect, it } from 'vitest'
import { isAiRetryDue, isAiRetryWaiting, isRecoverableFailure } from '@/contracts/workflow'

describe('workflow state contract', () => {
  const now = new Date('2026-07-28T00:00:00.000Z')

  it('只把未来的 AI pending 识别为等待，不把普通 pending 当失败', () => {
    expect(isAiRetryWaiting({ aiStatus: 'pending', nextAiRetryAt: new Date('2026-07-28T00:01:00.000Z') }, now)).toBe(true)
    expect(isAiRetryWaiting({ aiStatus: 'pending', nextAiRetryAt: null }, now)).toBe(false)
    expect(isAiRetryWaiting({ aiStatus: 'failed', nextAiRetryAt: new Date('2026-07-28T00:01:00.000Z') }, now)).toBe(false)
  })

  it('区分到期恢复和未到期等待', () => {
    expect(isAiRetryDue({ aiStatus: 'pending', nextAiRetryAt: now }, now)).toBe(true)
    expect(isAiRetryDue({ aiStatus: 'pending', nextAiRetryAt: new Date('2026-07-28T00:01:00.000Z') }, now)).toBe(false)
  })

  it('正常业务跳过不进入技术失败', () => {
    expect(isRecoverableFailure({ fetchStatus: 'fetched', aiStatus: 'skipped', clusterStatus: 'pending', skipReason: '无价值' })).toBe(false)
    expect(isRecoverableFailure({ fetchStatus: 'fetched', aiStatus: 'skipped', clusterStatus: 'pending', skipReason: 'AI 连续失败 5 次，已放弃' })).toBe(true)
    expect(isRecoverableFailure({ fetchStatus: 'fetched', aiStatus: 'done', clusterStatus: 'failed' })).toBe(true)
  })
})
