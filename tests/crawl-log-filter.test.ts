// @vitest-environment happy-dom

/**
 * crawl-log 筛选纯函数测试
 *
 * 不 mount 组件、不依赖数据库，直接断言：
 * - 每个 chip key 对 ArticleProgress 的命中逻辑
 * - 多选 chip 的 OR 联合语义 + 空集 = 不过滤
 * - countMatches 在边界条件下的行为
 * - applyFilterState：source scope / chip 联合 / includeDiscarded 切换
 * - URL 编解码：往返不变 + 防御性（未知 key / 空字符串）
 * - writeFilterToUrl 在 SSR 下安全（typeof window 判断）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ArticleProgress, FilterState, SourceProgress } from '../src/components/crawl-log/types';
import { EMPTY_FILTER_STATE } from '../src/components/crawl-log/types';
import {
  matchStepChip, articleMatchesChips, countMatches,
  applyFilterState, encodeFilterToSearch, decodeFilterFromSearch,
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
  it('ai-done / pushed 仅匹配 done', () => {
    expect(matchStepChip(article({ ai: 'done' }), 'ai-done')).toBe(true)
    expect(matchStepChip(article({ ai: 'pending' }), 'ai-done')).toBe(false)
    expect(matchStepChip(article({ push: 'done' }), 'pushed')).toBe(true)
    expect(matchStepChip(article({ push: 'pending' }), 'pushed')).toBe(false)
  })

  it('process-pending / ai-pending / push-pending 仅匹配 pending', () => {
    expect(matchStepChip(article({ process: 'pending' }), 'process-pending')).toBe(true)
    expect(matchStepChip(article({ process: 'done' }), 'process-pending')).toBe(false)
    expect(matchStepChip(article({ ai: 'pending' }), 'ai-pending')).toBe(true)
    expect(matchStepChip(article({ process: 'pending', ai: 'pending' }), 'ai-pending')).toBe(false)
    expect(matchStepChip(article({ ai: 'running' }), 'ai-pending')).toBe(false)
    expect(matchStepChip(article({ push: 'pending' }), 'push-pending')).toBe(true)
    expect(matchStepChip(article({ ai: 'pending', push: 'blocked' }), 'push-pending')).toBe(false)
    expect(matchStepChip(article({ ai: 'done', push: 'filtered' }), 'push-pending')).toBe(false)
  })

  it('聚类筛选区分待聚类、失败和待复核', () => {
    expect(matchStepChip(article({ cluster: 'pending', clusterStatus: 'pending' }), 'cluster-pending')).toBe(true)
    expect(matchStepChip(article({ cluster: 'failed', clusterStatus: 'failed' }), 'cluster-failed')).toBe(true)
    expect(matchStepChip(article({ cluster: 'done', clusterStatus: 'needs_review' }), 'cluster-review')).toBe(true)
    expect(matchStepChip(article({ cluster: 'done', clusterStatus: 'clustered' }), 'cluster-review')).toBe(false)
  })

  it('has-fail：任一步骤为 fail 即命中', () => {
    expect(matchStepChip(article({ crawl: 'failed' }), 'has-fail')).toBe(true)
    expect(matchStepChip(article({ process: 'failed' }), 'has-fail')).toBe(true)
    expect(matchStepChip(article({ cluster: 'failed', clusterStatus: 'failed' }), 'has-fail')).toBe(true)
    expect(matchStepChip(article({ ai: 'failed' }), 'has-fail')).toBe(true)
    expect(matchStepChip(article({ push: 'failed' }), 'has-fail')).toBe(true)
    expect(matchStepChip(article({
      crawl: 'done', process: 'done', cluster: 'done', ai: 'done', push: 'done',
    }), 'has-fail')).toBe(false)
  })

  it('ai-done 与 ai-pending 互斥', () => {
    const a = article({ ai: 'done' })
    expect(matchStepChip(a, 'ai-done')).toBe(true)
    expect(matchStepChip(a, 'ai-pending')).toBe(false)
  })
})

// ── 2. 多选 OR 联合 ──

describe('articleMatchesChips OR 联合', () => {
  it('空 chips 集合 = 不过滤（命中所有）', () => {
    const a = article({ ai: 'done' })
    expect(articleMatchesChips(a, new Set())).toBe(true)
    expect(articleMatchesChips(a, [])).toBe(true)
  })

  it('单 chip 命中 → true', () => {
    const a = article({ ai: 'done' })
    expect(articleMatchesChips(a, new Set(['ai-done']))).toBe(true)
  })

  it('单 chip 不命中 → false', () => {
    const a = article({ ai: 'pending' })
    expect(articleMatchesChips(a, new Set(['ai-done']))).toBe(false)
  })

  it('多 chip 任一命中 → true（OR）', () => {
    const a = article({ push: 'done' })  // pushed 命中，ai-done 不命中
    expect(articleMatchesChips(a, new Set(['ai-done', 'pushed']))).toBe(true)
  })

  it('多 chip 全部不命中 → false', () => {
    const a = article({ push: 'pending', ai: 'pending' })
    expect(articleMatchesChips(a, new Set(['pushed', 'ai-done']))).toBe(false)
  })

  it('迭代器在第一个命中后短路', () => {
    // 反向验证：传入一个会报错的迭代器在命中之后没人调用
    const a = article({ ai: 'done' })
    const iter = (function* () {
      yield 'has-fail' as const  // 第一个 yield 不命中
      yield 'ai-done' as const   // 第二个 yield 命中 — 此后迭代器不应再被调用
      throw new Error('迭代器在命中后不应继续')
    })()
    expect(articleMatchesChips(a, iter)).toBe(true)
  })
})

// ── 3. countMatches ──

describe('countMatches', () => {
  it('空数组 → 0', () => {
    expect(countMatches([], 'ai-done')).toBe(0)
  })
  it('统计命中数', () => {
    const list = [
      article({ ai: 'done' }),
      article({ ai: 'pending' }),
      article({ ai: 'done' }),
    ]
    expect(countMatches(list, 'ai-done')).toBe(2)
  })
})

// ── 4. applyFilterState ──

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

  it('chip OR 联合过滤 articles', () => {
    const out = applyFilterState(allSources, {
      ...EMPTY_FILTER_STATE,
      chips: new Set(['ai-done', 'pushed']),
    })
    const allArticles = out.flatMap(s => s.articles.map(a => a.id)).sort()
    expect(allArticles).toEqual(['1', '2'])  // s1 的两条 hits，s2 都不命中
  })

  it('sourceId scope 与 chip 联合', () => {
    const out = applyFilterState(allSources, {
      ...EMPTY_FILTER_STATE,
      sourceId: 's2',
      chips: new Set(['has-fail']),
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
      chips: new Set(['pushed']),
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
    applyFilterState(allSources, { ...EMPTY_FILTER_STATE, chips: new Set(['has-fail']) })
    expect(allSources).toEqual(original)
  })
})

// ── 5. URL 编解码往返 + 防御性 ──

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

  it('chips → chips=key1,key2', () => {
    const state: FilterState = {
      ...EMPTY_FILTER_STATE, chips: new Set(['ai-done', 'pushed']),
    }
    expect(encodeFilterToSearch(state).get('chips')).toBe('ai-done,pushed')
  })

  it('完整 state（含 chips + 源，includeDiscarded=默认）→ 不写 disc', () => {
    const state: FilterState = {
      chips: new Set(['has-fail']),
      sourceId: 'src-xyz',
      includeDiscarded: true, // 等于默认值，不写出
      publishedToday: false,
    }
    expect(encodeFilterToSearch(state).toString()).toBe('chips=has-fail&src=src-xyz')
  })

  it('解码未知 chip key → 丢弃，保留有效', () => {
    const s = decodeFilterFromSearch('chips=ai-done,__bogus__,has-fail')
    expect(Array.from(s.chips).sort()).toEqual(['ai-done', 'has-fail'])
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
      chips: new Set(['has-fail', 'ai-pending']),
      sourceId: 'abc',
      includeDiscarded: true,
      publishedToday: false,
    }
    const params = encodeFilterToSearch(state).toString()
    const decoded = decodeFilterFromSearch(params)
    expect(Array.from(decoded.chips).sort()).toEqual(['ai-pending', 'has-fail'])
    expect(decoded.sourceId).toBe('abc')
    expect(decoded.includeDiscarded).toBe(true)
  })

  it('encode filter 掉不存在的 chip key（防御性写入）', () => {
    const state = {
      ...EMPTY_FILTER_STATE,
      chips: new Set(['ai-done', '__bogus__' as never]),
    } as FilterState
    const params = encodeFilterToSearch(state)
    expect(params.get('chips')).toBe('ai-done')
  })
})

// ── 6. writeFilterToUrl / readFilterFromCurrentUrl（浏览器侧） ──

describe('writeFilterToUrl & readFilterFromCurrentUrl', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('写入状态后 URL 出现 chips 与 src 参数', () => {
    writeFilterToUrl({
      chips: new Set(['ai-done']),
      sourceId: 'src-1',
      includeDiscarded: false,
      publishedToday: false,
    })
    expect(window.location.search).toContain('chips=ai-done')
    expect(window.location.search).toContain('src=src-1')
  })

  it('写入筛选时保留详情深链参数', () => {
    window.history.replaceState(null, '', '/?detail=a-1&detailKind=article&tab=crawl-log')
    writeFilterToUrl({
      ...EMPTY_FILTER_STATE,
      chips: new Set(['ai-done']),
    })
    expect(window.location.search).toContain('detail=a-1')
    expect(window.location.search).toContain('detailKind=article')
    expect(window.location.search).toContain('tab=crawl-log')
    expect(window.location.search).toContain('chips=ai-done')
  })

  it('空 state 写入 → URL 完全干净（无 search 参数）', () => {
    // 先污染一下 URL
    window.history.replaceState(null, '', '/?chips=ai-done')
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
    window.history.replaceState(null, '', '/?chips=has-fail&disc=1')
    expect(readFilterFromCurrentUrl()).toEqual({
      chips: new Set(['has-fail']),
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
    writeFilterToUrl({ ...EMPTY_FILTER_STATE, chips: new Set(['ai-done']) })
    expect(window.location.hash).toBe('#section')
  })

  it('替换写入不增加 history.length（不污染历史栈）', () => {
    const lenBefore = window.history.length
    writeFilterToUrl({ ...EMPTY_FILTER_STATE, chips: new Set(['ai-done']) })
    writeFilterToUrl({ ...EMPTY_FILTER_STATE, chips: new Set(['pushed']) })
    writeFilterToUrl(EMPTY_FILTER_STATE)
    expect(window.history.length).toBe(lenBefore)
  })
})
