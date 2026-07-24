'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Plus,
  Trash2,
  X,
  Loader2,
  Tag,
  Upload,
  Download,
  Search,
} from 'lucide-react'
import { toast } from 'sonner'
import { KEYWORD_CATEGORIES } from '@/features/keywords-catalog'
import { EmptyState } from '@/components/ui/empty-state'
import {
  bulkAddKeywords,
  bulkClearKeywords,
  deleteKeyword,
  deleteKeywordCandidate,
  exportKeywordsXlsxBlob,
  fetchKeywords,
  importKeywordsXlsx,
  fetchKeywordCandidates,
  updateKeywordCandidate,
  type KeywordCandidate,
} from '@/features/keywords-api.client'

// ========== Types ==========

interface Keyword {
  id: string
  category: string
  word: string
  createdAt?: string
  hitCount: number
}

type BulkAction = 'clear-all'

type KeywordGroup =
  | { key: string; label: string; kind: 'keywords'; items: Keyword[] }
  | { key: string; label: string; kind: 'candidates'; items: KeywordCandidate[] }

// ========== Main Keywords Tab ==========

export default function KeywordsTab() {
  const [keywords, setKeywords] = useState<Keyword[]>([])
  const [candidates, setCandidates] = useState<KeywordCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [clearAllDialogOpen, setClearAllDialogOpen] = useState(false)
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadKeywords = useCallback(async () => {
    try {
      const [data, candidateData] = await Promise.all([fetchKeywords(), fetchKeywordCandidates()])
      setKeywords(data)
      setCandidates(candidateData)
    } catch {
      toast.error('获取关键词失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleCandidate = async (candidate: KeywordCandidate, action: 'approve-candidate' | 'dismiss-candidate') => {
    try {
      const result = await updateKeywordCandidate(candidate.id, action)
      await loadKeywords()
      toast.success(action === 'approve-candidate' ? `已采用「${candidate.phrase}」，恢复 ${result.restored} 篇${result.processQueued ? '，处理流水线已启动' : ''}` : '候选词已永久忽略')
    } catch {
      toast.error('候选词操作失败')
    }
  }

  useEffect(() => {
    const handle = setTimeout(loadKeywords, 0)
    return () => clearTimeout(handle)
  }, [loadKeywords])

  const handleDelete = async (id: string) => {
    try {
      await deleteKeyword(id)
      toast.success('关键词已删除')
      loadKeywords()
    } catch {
      toast.error('删除失败')
    }
  }

  const handleSearch = () => setSearch(searchInput.trim())

  const handleDeleteCandidate = async (candidate: KeywordCandidate) => {
    try {
      await deleteKeywordCandidate(candidate.id)
      toast.success('处理后的关键词已删除')
      loadKeywords()
    } catch {
      toast.error('删除失败')
    }
  }

  const runBulkAction = async (action: BulkAction) => {
    setBulkLoading(true)
    try {
      const data = await bulkClearKeywords()
      toast.success(`已清空 ${data.deleted} 个关键词`)
      loadKeywords()
    } catch {
      toast.error('操作失败')
    } finally {
      setBulkLoading(false)
      setClearAllDialogOpen(false)
    }
    void action
  }

  const handleClearAll = () => runBulkAction('clear-all')

  const handleBulkAdd = async () => {
    if (!bulkText.trim()) return
    setBulkLoading(true)
    try {
      const data = await bulkAddKeywords(bulkText)
      if (data.error) {
        toast.error(data.error)
        return
      }
      const skippedHint = data.skipped && data.skipped > 0 ? `（${data.skipped} 个重复已在词库）` : ''
      toast.success(`已添加 ${data.imported} 个关键词${skippedHint}`)
      setBulkText('')
      loadKeywords()
    } catch {
      toast.error('添加失败')
    } finally {
      setBulkLoading(false)
    }
  }

  const handleExport = async () => {
    try {
      const blob = await exportKeywordsXlsxBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'keywords.xlsx'
      a.click()
      URL.revokeObjectURL(url)
      toast.success('已导出关键词及候选词状态')
    } catch {
      toast.error('导出失败')
    }
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setBulkLoading(true)
    try {
      const data = await importKeywordsXlsx(file)
      toast.success(`已导入 ${data.imported} 个关键词，恢复 ${data.restored} 篇，候选状态已同步`)
      loadKeywords()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : '导入失败，请检查 XLSX 工作簿格式')
    } finally {
      setBulkLoading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // Group keywords by category
  const filtered = search.trim()
    ? keywords.filter(kw => kw.word.includes(search.trim()))
    : keywords
  const grouped = filtered.reduce<Record<string, Keyword[]>>((acc, kw) => {
    if (!acc[kw.category]) acc[kw.category] = []
    acc[kw.category].push(kw)
    return acc
  }, {})
  // 先按组内数量排序，数量相同再沿用目录顺序。
  const groupKeys = Object.keys(grouped).sort((a, b) => {
    const countDifference = grouped[b].length - grouped[a].length
    if (countDifference !== 0) return countDifference
    const ai = KEYWORD_CATEGORIES.indexOf(a as (typeof KEYWORD_CATEGORIES)[number])
    const bi = KEYWORD_CATEGORIES.indexOf(b as (typeof KEYWORD_CATEGORIES)[number])
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    return a.localeCompare(b)
  })
  const pendingCandidates = candidates.filter(candidate => candidate.status === 'pending')
  const reviewedCandidates = candidates.filter(candidate => candidate.status !== 'pending')
  const reviewedCandidateGroups = [
    { key: 'approved', label: '已采用', items: reviewedCandidates.filter(candidate => candidate.status === 'approved') },
    { key: 'dismissed', label: '永久忽略', items: reviewedCandidates.filter(candidate => candidate.status === 'dismissed') },
  ]
  const getGroupPriority = (group: KeywordGroup) => {
    if (group.key === 'dismissed') return 0
    if (group.kind === 'keywords' && group.label === '提取') return 1
    if (group.key === 'approved') return 2
    if (group.kind === 'keywords' && group.label === 'default') return 3
    return 4
  }
  const keywordGroups: KeywordGroup[] = [
    ...groupKeys.map(group => ({ key: `keyword-${group}`, label: group, kind: 'keywords' as const, items: grouped[group] })),
    ...reviewedCandidateGroups.map(group => ({ key: group.key, label: group.label, kind: 'candidates' as const, items: group.items })),
  ].filter(group => group.items.length > 0)
    .map((group, index) => ({ group, index }))
    .sort((left, right) => {
      const priorityDifference = getGroupPriority(left.group) - getGroupPriority(right.group)
      if (priorityDifference !== 0) return priorityDifference
      return right.group.items.length - left.group.items.length || left.index - right.index
    })
    .map(({ group }) => group)
  const sortedKeywordGroups: KeywordGroup[] = keywordGroups.map(group => (
    group.kind === 'keywords'
      ? { ...group, items: [...group.items].sort((left, right) => right.hitCount - left.hitCount || left.word.localeCompare(right.word)) }
      : { ...group, items: [...group.items].sort((left, right) => right.occurrences - left.occurrences || left.phrase.localeCompare(right.phrase)) }
  ))

  const getGroupClassName = (group: KeywordGroup) => {
    if (group.key === 'dismissed') return 'border-rose-200 bg-rose-50/60 dark:border-rose-900/50 dark:bg-rose-950/20'
    if (group.kind === 'keywords' && group.label === '提取') return 'border-sky-200 bg-sky-50/60 dark:border-sky-900/50 dark:bg-sky-950/20'
    if (group.key === 'approved') return 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/50 dark:bg-emerald-950/20'
    if (group.kind === 'keywords' && group.label === 'default') return 'border-amber-200 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20'
    return 'border-border/50 bg-background'
  }

  const renderKeywordGroupItem = (item: Keyword | KeywordCandidate, groupLabel: string) => {
    const isKeyword = 'word' in item
    const word = isKeyword ? item.word : item.phrase
    const count = isKeyword ? item.hitCount : item.occurrences
    const countLabel = isKeyword ? '命中' : '出现'
    const handleItemDelete = () => {
      if (isKeyword) void handleDelete(item.id)
      else void handleDeleteCandidate(item)
    }

    return (
      <div key={item.id} className="flex min-h-5 w-fit max-w-full items-center gap-0.5 py-0" title={`${countLabel} ${count} 次`}>
        <span className="truncate text-[11px]">{word}</span>
        <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">({count})</span>
        <button
          type="button"
          onClick={handleItemDelete}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-destructive"
          aria-label={`删除${groupLabel}关键词 ${word}`}
          title={`删除「${word}」`}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    )
  }

  const renderCandidate = (candidate: KeywordCandidate) => (
    <div key={candidate.id} className="flex min-h-6 items-center gap-1 px-1.5 py-0.5">
      <span
        className="min-w-0 flex-1 truncate text-[11px] font-medium"
        title={candidate.sampleTitles.length > 0 ? candidate.sampleTitles.join('；') : candidate.phrase}
      >
        {candidate.phrase}
      </span>
      <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
        出现 {candidate.occurrences} 次 · {candidate.sourceCount} 来源 · 可恢复 {candidate.recallCount} 篇
      </span>
      <Button
        size="sm"
        className="h-5 min-h-5 shrink-0 px-1 text-[10px] leading-none"
        onClick={() => void handleCandidate(candidate, 'approve-candidate')}
        aria-label="采用并恢复"
        title="采用并恢复"
      >
        采用
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-5 min-h-5 shrink-0 px-1 text-[10px] leading-none"
        onClick={() => void handleCandidate(candidate, 'dismiss-candidate')}
        aria-label="永久忽略"
        title="永久忽略"
      >
        忽略
      </Button>
    </div>
  )

  if (loading) {
    return (
      <div className="space-y-2 p-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b bg-background px-2 py-1.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Tag className="h-3.5 w-3.5 text-primary shrink-0" />
          <span className="text-xs font-semibold">关键词管理</span>
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{keywords.length}</Badge>
          <span className="hidden text-[10px] text-muted-foreground sm:inline">命中即抓取；未命中丢弃；XLSX 同步候选词状态</span>
          <div className="flex-1" />
          <div className="flex items-center gap-1 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={handleImport}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-1.5 text-[11px]"
              onClick={() => fileInputRef.current?.click()}
              disabled={bulkLoading}
            >
              <Upload className="h-3 w-3" />
              <span className="hidden sm:inline">导入</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-1.5 text-[11px]"
              onClick={handleExport}
              disabled={keywords.length === 0 && candidates.length === 0}
            >
              <Download className="h-3 w-3" />
              <span className="hidden sm:inline">导出</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-1.5 text-[11px] text-destructive hover:text-destructive"
              onClick={() => setClearAllDialogOpen(true)}
              disabled={keywords.length === 0 || bulkLoading}
            >
              <Trash2 className="h-3 w-3" />
              <span className="hidden sm:inline">清空</span>
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex min-h-full flex-col gap-1.5 p-1.5">
          <section className="flex items-center gap-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <Textarea
                rows={1}
                placeholder="输入关键词（每行一个）..."
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                className="h-8 min-h-8 min-w-0 flex-1 resize-y py-1.5 text-xs focus-visible:border-foreground/50 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              <Button size="sm" variant="outline" onClick={handleBulkAdd} disabled={!bulkText.trim() || bulkLoading} className="h-8 shrink-0 gap-1 px-2 text-xs">
                {bulkLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                添加
              </Button>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Input
                className="h-8 w-32 text-xs focus-visible:border-foreground/50 focus-visible:ring-0 focus-visible:ring-offset-0 sm:w-40"
                placeholder="搜索关键词..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSearch()
                }}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8 shrink-0 gap-1 px-2 text-xs"
                onClick={handleSearch}
                title="搜索关键词"
              >
                <Search className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">搜索</span>
              </Button>
              {search && <span className="shrink-0 text-[10px] text-muted-foreground">
                {groupKeys.reduce((acc, g) => acc + grouped[g].filter(kw => kw.word.includes(search)).length, 0)} 个结果
              </span>}
            </div>
          </section>

          <div className={pendingCandidates.length > 0 ? 'grid min-h-0 gap-1.5 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]' : 'min-h-0'}>
            {pendingCandidates.length > 0 && <section className="min-w-0 overflow-hidden border border-amber-300 bg-amber-50/50 dark:bg-amber-950/10">
              <div className="flex h-7 items-center gap-1.5 border-b border-amber-300 px-1.5">
                <span className="text-xs font-medium">待确认候选</span>
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{pendingCandidates.length}</Badge>
                <span className="truncate text-[10px] text-muted-foreground">确认后加入词库</span>
              </div>
              <div className="max-h-[520px] overflow-y-auto divide-y divide-border/60 bg-background">
                {pendingCandidates.map(renderCandidate)}
              </div>
            </section>}

            <section className="min-w-0 overflow-hidden border bg-background">
              <div className="flex h-7 items-center gap-1.5 border-b px-1.5">
                <span className="shrink-0 text-xs font-medium">关键词分组</span>
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{keywords.length + reviewedCandidates.length}</Badge>
              </div>

              <div className="max-h-[520px] overflow-auto p-1">
                {keywords.length === 0 && reviewedCandidates.length === 0 ? (
                  <EmptyState
                    title="暂无关键词"
                    description="请添加要抓取的关键词（命中即入库）；词库为空时不过滤"
                    className="py-6"
                  />
                ) : keywordGroups.length === 0 ? (
                  <EmptyState title={`未找到包含「${search}」的关键词`} className="py-6" />
                ) : (
                  <div className="flex w-max min-w-full flex-nowrap items-start gap-1">
                    {sortedKeywordGroups.map(group => (
                      <section key={group.key} className={`w-fit shrink-0 overflow-hidden border ${getGroupClassName(group)}`}>
                        <div className="flex h-5 items-center gap-0.5 border-b border-inherit bg-transparent px-1.5">
                          <span className="truncate text-[11px] font-medium text-muted-foreground">{group.label}</span>
                          <span className="text-[10px] text-muted-foreground">({group.items.length})</span>
                        </div>
                        <div className="space-y-0 px-1.5 py-0.5">
                          {group.items.map(item => renderKeywordGroupItem(item, group.label))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </ScrollArea>

      <AlertDialog open={clearAllDialogOpen} onOpenChange={setClearAllDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空所有关键词?</AlertDialogTitle>
            <AlertDialogDescription>
              将删除全部 {keywords.length} 个关键词，清空后所有文章将不再进行关键词过滤。
              此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkLoading}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClearAll}
              disabled={bulkLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {bulkLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              确认清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
