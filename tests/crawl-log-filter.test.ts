// @vitest-environment happy-dom

/**
 * crawl-log 筛选纯函数测试
 *
 * 不 mount 组件、不依赖数据库，直接断言：
 * - 每个 chip key 对 ArticleProgress 的命中逻辑
 * - 单选状态语义 + 空集 = 不过滤
 * - applyFilterState：source scope / 状态筛选 / includeDiscarded 切换
 * - URL 编解码：往返不变 + 防御性（未知 key / 空字符串）
 * - writeFilterToUrl 在 SSR 下安全（typeof window 判断）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ArticleProgress, FilterState, SourceProgress } from '../src/components/crawl-log/types';
import { EMPTY_FILTER_STATE } from '../src/components/crawl-log/types';
import {
  matchStepChip, applyFilterState, encodeFilterToSearch, decodeFilterFromSearch,
  writeFilterToUrl, readFilterFromCurrentUrl,
} from '../src/components/crawl-log/filter';

// ── 工厂：可读 article/source 生成器 ──

function article(partial: Partial<ArticleProgress>): ArticleProgress {
  return {
    id: 'a',
    title: 't',
    crawl: 'done',
    process: 'done',
    cluster: 'done',
    clusterStatus: 'clustered',
    ai: 'pending',
    score: null,
    anomalyLabels: [],
    push: 'pending',
    lastTime: 0,
    technicalIssues: [],
    isEventRepresentative: true,
    ...partial,
  }
}

function source(id: string, articles: ArticleProgress[], discarded: SourceProgress['discarded'] = []): SourceProgress {
  return {
    id, name: id, status: 'success',
    articles, discarded, deduped: 0, filtered: 0, itemsFound: articles.length,
    expanded: true,
  }
}

// ── 1. 单 chip 命中逻辑 ──

describe('matchStepChip 单谓词命中', () => {
  it('正常与异常一级状态保持互斥', () => {
    expect(matchStepChip(article({ ai: 'pending' }), 'normal-ai')).toBe(true)
    expect(matchStepChip(article({ ai: 'pending' }), 'anomaly-all')).toBe(false)
    expect(matchStepChip(article({ crawl: 'failed' }), 'anomaly-failure')).toBe(true)
    expect(matchStepChip(article({ crawl: 'failed' }), 'normal-all')).toBe(false)
  })

  it('软文和重复按业务标签独立命中', () => {
    expect(matchStepChip(article({ anomalyLabels: ['ad'] }), 'anomaly-ad')).toBe(true)
    expect(matchStepChip(article({ anomalyLabels: ['duplicate'] }), 'anomaly-duplicate')).toBe(true)
  })
})

// ── 2. applyFilterState ──

describe('applyFilterState', () => {
  const s1 = source('s1', [
    article({ id: '1', ai: 'done' }),
    article({ id: '2', push: 'done' }),
  ], [{ id: 'd1', title: 'd', reason: 'filter:keyword' }])

  const s2 = source('s2', [
    article({ id: '3', ai: 'pending' }),
    article({ id: '4', crawl: 'failed' }),
  ])

  const allSources = [s1, s2]

  it('空过滤状态 → 原样返回', () => {
    expect(applyFilterState(allSources, EMPTY_FILTER_STATE)).toEqual(allSources)
  })

  it('sourceId scope 过滤：只留指定源', () => {
    const out = applyFilterState(allSources, {
      ...EMPTY_FILTER_STATE, sourceId: 's1',
    })
    expect(out.map(s => s.id)).toEqual(['s1'])
  })

  it('状态筛选只使用一个值', () => {
    const out = applyFilterState(allSources, {
      ...EMPTY_FILTER_STATE,
      chips: new Set(['normal-ai']),
    })
    const allArticles = out.flatMap(s => s.articles.map(a => a.id)).sort()
    expect(allArticles).toEqual(['3'])
  })

  it('sourceId scope 与 chip 联合', () => {
    const out = applyFilterState(allSources, {
      ...EMPTY_FILTER_STATE,
      sourceId: 's2',
      chips: new Set(['anomaly-failure']),
    })
    expect(out).toHaveLength(1)
    expect(out[0].articles.map(a => a.id)).toEqual(['4'])
  })

  it('includeDiscarded: false → 清空 discarded 字段', () => {
    const out = applyFilterState(allSources, { ...EMPTY_FILTER_STATE, includeDiscarded: false })
    expect(out.find(s => s.id === 's1')!.discarded).toEqual([])
  })

  it('includeDiscarded: true（默认值）→ 保留 discarded', () => {
    // EMPTY_FILTER_STATE 默认 includeDiscarded=true，是默认行为
    const out = applyFilterState(allSources, EMPTY_FILTER_STATE)
    expect(out.find(s => s.id === 's1')!.discarded).toEqual([{ id: 'd1', title: 'd', reason: 'filter:keyword' }])
  })

  it('过滤后空 source 不出现在结果里', () => {
    const out = applyFilterState(allSources, {
      ...EMPTY_FILTER_STATE,
      chips: new Set(['normal-pushed']),
    })
    expect(out.map(s => s.id)).toEqual(['s1'])  // s2 被筛掉
  })

  it('过滤后 source 无文章但有 discarded 时仍保留', () => {
    const onlyDiscarded = source('sX', [], [{ id: 'd', title: 'd', reason: 'filter:keyword' }])
    const out = applyFilterState([onlyDiscarded], { ...EMPTY_FILTER_STATE, includeDiscarded: false })
    expect(out).toEqual([])
    const out2 = applyFilterState([onlyDiscarded], { ...EMPTY_FILTER_STATE, includeDiscarded: true })
    expect(out2).toHaveLength(1)
    expect(out2[0].discarded).toHaveLength(1)
  })

  it('返回新数组，不修改原 sources', () => {
    const original: SourceProgress[] = JSON.parse(JSON.stringify(allSources))
    applyFilterState(allSources, { ...EMPTY_FILTER_STATE, chips: new Set(['anomaly-failure']) })
    expect(allSources).toEqual(original)
  })
})

// ── 3. URL 编解码往返 + 防御性 ──

describe('encodeFilterToSearch ↔ decodeFilterFromSearch 往返', () => {
  it('空 state → 完全空 params（URL 干净，不残留 disc=1）', () => {
    // 与 EMPTY_FILTER_STATE 等价的字段不写入 URL，让"清空筛选"自然产生干净 URL
    expect(encodeFilterToSearch(EMPTY_FILTER_STATE).toString()).toBe('')
  })

  it('源 = all + 含未入库=默认值 → 真空（即使 fields 显式指定）', () => {
    const equivalentToEmpty: FilterState = {
      chips: new Set(),
      sourceId: 'all',
      includeDiscarded: true,
      publishedToday: false,
    }
    expect(encodeFilterToSearch(equivalentToEmpty).toString()).toBe('')
  })

  it('仅含未入库=false（显式关闭）→ 只写 disc=0', () => {
    const off: FilterState = {
      chips: new Set(),
      sourceId: 'all',
      includeDiscarded: false,
      publishedToday: false,
    }
    expect(encodeFilterToSearch(off).toString()).toBe('disc=0')
  })

  it('状态参数只编码一个值', () => {
    const state: FilterState = {
      ...EMPTY_FILTER_STATE, chips: new Set(['normal-ai', 'normal-pushed']),
    }
    expect(encodeFilterToSearch(state).get('chips')).toBe('normal-ai')
  })

  it('完整 state（含 chips + 源，includeDiscarded=默认）→ 不写 disc', () => {
    const state: FilterState = {
      chips: new Set(['anomaly-failure']),
      sourceId: 'src-xyz',
      includeDiscarded: true, // 等于默认值，不写出
      publishedToday: false,
    }
    expect(encodeFilterToSearch(state).toString()).toBe('chips=anomaly-failure&src=src-xyz')
  })

  it('解码多值参数时保留第一个有效状态', () => {
    const s = decodeFilterFromSearch('chips=normal-ai,__bogus__,anomaly-failure')
    expect(Array.from(s.chips)).toEqual(['normal-ai'])
  })

  it('解码空 / 缺失的 src → 默认为 all', () => {
    expect(decodeFilterFromSearch('src=').sourceId).toBe('all')
    expect(decodeFilterFromSearch('').sourceId).toBe('all')
  })

  it('解码 disc 默认行为对齐 EMPTY_FILTER_STATE', () => {
    // 无参数 → 默认 true（与 EMPTY_FILTER_STATE 一致）
    expect(decodeFilterFromSearch('').includeDiscarded).toBe(true)
    // disc=1 → true
    expect(decodeFilterFromSearch('disc=1').includeDiscarded).toBe(true)
    // disc=0 / disc=false → 显式 false
    expect(decodeFilterFromSearch('disc=0').includeDiscarded).toBe(false)
    expect(decodeFilterFromSearch('disc=false').includeDiscarded).toBe(false)
  })

  it('空字符串 / 无效 search 字符串解码得到默认 state', () => {
    expect(decodeFilterFromSearch('')).toEqual(EMPTY_FILTER_STATE)
    expect(decodeFilterFromSearch('garbage=1')).toEqual(EMPTY_FILTER_STATE)
  })

  it('encode → decode 往返：状态可重建', () => {
    const state: FilterState = {
      chips: new Set(['anomaly-failure']),
      sourceId: 'abc',
      includeDiscarded: true,
      publishedToday: false,
    }
    const params = encodeFilterToSearch(state).toString()
    const decoded = decodeFilterFromSearch(params)
    expect(Array.from(decoded.chips)).toEqual(['anomaly-failure'])
    expect(decoded.sourceId).toBe('abc')
    expect(decoded.includeDiscarded).toBe(true)
  })

  it('encode filter 掉不存在的 chip key（防御性写入）', () => {
    const state = {
      ...EMPTY_FILTER_STATE,
      chips: new Set(['normal-ai', '__bogus__' as never]),
    } as FilterState
    const params = encodeFilterToSearch(state)
    expect(params.get('chips')).toBe('normal-ai')
  })
})

// ── 4. writeFilterToUrl / readFilterFromCurrentUrl（浏览器侧） ──

describe('writeFilterToUrl & readFilterFromCurrentUrl', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('写入状态后 URL 出现 chips 与 src 参数', () => {
    writeFilterToUrl({
      chips: new Set(['normal-ai']),
      sourceId: 'src-1',
      includeDiscarded: false,
      publishedToday: false,
    })
    expect(window.location.search).toContain('chips=normal-ai')
    expect(window.location.search).toContain('src=src-1')
  })

  it('写入筛选时保留详情深链参数', () => {
    window.history.replaceState(null, '', '/?detail=a-1&detailKind=article&tab=crawl-log')
    writeFilterToUrl({
      ...EMPTY_FILTER_STATE,
      chips: new Set(['normal-ai']),
    })
    expect(window.location.search).toContain('detail=a-1')
    expect(window.location.search).toContain('detailKind=article')
    expect(window.location.search).toContain('tab=crawl-log')
    expect(window.location.search).toContain('chips=normal-ai')
  })

  it('空 state 写入 → URL 完全干净（无 search 参数）', () => {
    // 先污染一下 URL
    window.history.replaceState(null, '', '/?chips=normal-ai')
    writeFilterToUrl(EMPTY_FILTER_STATE)
    expect(window.location.search).toBe('')
  })

  it('相同 state 不重复写入（无操作）', () => {
    writeFilterToUrl(EMPTY_FILTER_STATE)
    const before = window.location.search
    writeFilterToUrl(EMPTY_FILTER_STATE)
    expect(window.location.search).toBe(before)
  })

  it('readFilterFromCurrentUrl：当前 URL 无参数 → EMPTY', () => {
    expect(readFilterFromCurrentUrl()).toEqual(EMPTY_FILTER_STATE)
  })

  it('readFilterFromCurrentUrl：含参数 → 解码得到状态', () => {
    window.history.replaceState(null, '', '/?chips=anomaly-failure&disc=1')
    expect(readFilterFromCurrentUrl()).toEqual({
      chips: new Set(['anomaly-failure']),
      sourceId: 'all',
      includeDiscarded: true,
      publishedToday: false,
    })
  })

  it('sourceId 包含特殊字符也能正常往返（URL 编码由 URLSearchParams 处理）', () => {
    writeFilterToUrl({ ...EMPTY_FILTER_STATE, sourceId: 'has space & ampersand' })
    const restored = readFilterFromCurrentUrl()
    expect(restored.sourceId).toBe('has space & ampersand')
  })

  it('写 URL 时不污染 hash', () => {
    window.history.replaceState(null, '', '/#section')
    writeFilterToUrl({ ...EMPTY_FILTER_STATE, chips: new Set(['normal-ai']) })
    expect(window.location.hash).toBe('#section')
  })

  it('替换写入不增加 history.length（不污染历史栈）', () => {
    const lenBefore = window.history.length
    writeFilterToUrl({ ...EMPTY_FILTER_STATE, chips: new Set(['normal-ai']) })
    writeFilterToUrl({ ...EMPTY_FILTER_STATE, chips: new Set(['normal-pushed']) })
    writeFilterToUrl(EMPTY_FILTER_STATE)
    expect(window.history.length).toBe(lenBefore)
  })
})
