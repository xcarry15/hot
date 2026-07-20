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
} from 'lucide-react'
import { toast } from 'sonner'
import { KEYWORD_CATEGORIES } from '@/features/keywords-catalog'
import { EmptyState } from '@/components/ui/empty-state'
import {
  bulkAddKeywords,
  bulkClearKeywords,
  deleteKeyword,
  exportKeywordsCsvBlob,
  fetchKeywords,
  importKeywordsCsv,
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
}

type BulkAction = 'clear-all'

// ========== Main Keywords Tab ==========

export default function KeywordsTab() {
  const [keywords, setKeywords] = useState<Keyword[]>([])
  const [candidates, setCandidates] = useState<KeywordCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [clearAllDialogOpen, setClearAllDialogOpen] = useState(false)
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [search, setSearch] = useState('')
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
      setCandidates((prev) => prev.filter((item) => item.id !== candidate.id))
      if (action === 'approve-candidate') await loadKeywords()
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
      const blob = await exportKeywordsCsvBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'keywords.csv'
      a.click()
      URL.revokeObjectURL(url)
      toast.success('已导出关键词')
    } catch {
      toast.error('导出失败')
    }
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setBulkLoading(true)
    try {
      const text = await file.text()
      const data = await importKeywordsCsv(text)
      if (data.error) throw new Error(data.error)
      toast.success(`已导入 ${data.imported} 个，跳过 ${data.skipped} 个`)
      loadKeywords()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : '导入失败，请检查 CSV 格式（类型, 关键词）')
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
  // Sort groups: known categories first, then others alphabetically
  const groupKeys = Object.keys(grouped).sort((a, b) => {
    const ai = KEYWORD_CATEGORIES.indexOf(a as (typeof KEYWORD_CATEGORIES)[number])
    const bi = KEYWORD_CATEGORIES.indexOf(b as (typeof KEYWORD_CATEGORIES)[number])
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    return a.localeCompare(b)
  })

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
      <div className="border-b bg-background px-3 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Tag className="h-4 w-4 text-primary shrink-0" />
          <span className="text-sm font-semibold">关键词管理</span>
          <Badge variant="secondary" className="text-xs px-2 py-0">{keywords.length}</Badge>
          <span className="text-xs text-muted-foreground hidden sm:inline">命中即抓取；未命中丢弃；词库为空时不过滤</span>
          <div className="flex-1" />
          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleImport}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={() => fileInputRef.current?.click()}
              disabled={bulkLoading}
            >
              <Upload className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">导入</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={handleExport}
              disabled={keywords.length === 0}
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">导出</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2.5 text-xs text-destructive hover:text-destructive"
              onClick={() => setClearAllDialogOpen(true)}
              disabled={keywords.length === 0 || bulkLoading}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">清空</span>
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-2 p-2">
          {/* Add Keywords */}
          <section className="flex items-start gap-2">
            <Textarea
              placeholder="输入关键词（每行一个）..."
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              className="min-h-[58px] flex-1 resize-y text-xs"
            />
            <Button size="sm" onClick={handleBulkAdd} disabled={!bulkText.trim() || bulkLoading} className="h-8 shrink-0 gap-1.5 px-3 text-xs">
              {bulkLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              添加
            </Button>
          </section>

          {candidates.length > 0 && <section className="border border-amber-300 bg-amber-50/50 p-2.5 dark:bg-amber-950/10">
            <div className="mb-2 flex items-center gap-2"><span className="text-sm font-medium">未命中候选词</span><Badge variant="secondary" className="text-xs">{candidates.length}</Badge><span className="text-xs text-muted-foreground">本地统计生成，需人工确认后加入词库</span></div>
            <div className="space-y-1">{candidates.slice(0, 12).map((candidate) => <div key={candidate.id} className="border bg-background px-2.5 py-1.5"><div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs font-medium">{candidate.phrase}</span><span className="shrink-0 text-[11px] text-muted-foreground">出现 {candidate.occurrences} 次 · {candidate.sourceCount} 个来源 · 可恢复 {candidate.recallCount} 篇</span><Button size="sm" className="h-7 px-2 text-xs" onClick={() => void handleCandidate(candidate, 'approve-candidate')}>采用并恢复</Button><Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void handleCandidate(candidate, 'dismiss-candidate')}>永久忽略</Button></div>{candidate.sampleTitles.length > 0 && <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">{candidate.sampleTitles.slice(0, 3).map((title) => <p key={title} className="truncate">· {title}</p>)}</div>}</div>)}</div>
          </section>}

          {/* Search */}
          <div className="flex items-center gap-2">
            <Input
              className="h-7 w-44 text-xs"
              placeholder="搜索关键词..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <span className="text-xs text-muted-foreground">
                {groupKeys.reduce((acc, g) => acc + grouped[g].filter(kw => kw.word.includes(search)).length, 0)} 个结果
              </span>
            )}
          </div>

          {keywords.length === 0 ? (
            <EmptyState
              title="暂无关键词"
              description="请添加要抓取的关键词（命中即入库）；词库为空时不过滤"
              className="py-6"
            />
          ) : groupKeys.length === 0 ? (
            <EmptyState
              title={`未找到包含「${search}」的关键词`}
              className="py-6"
            />
          ) : (
            <div className="space-y-2">
              {groupKeys.map(group => (
                <section key={group}>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-sm font-medium text-muted-foreground">{group}</span>
                    <Badge variant="secondary" className="text-xs px-2 py-0">{grouped[group].length}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {grouped[group].map(kw => (
                      <Badge key={kw.id} variant="outline" className="gap-1 px-2 py-0.5 text-xs font-normal">
                        {kw.word}
                        <button
                          onClick={() => handleDelete(kw.id)}
                          className="hover:text-destructive"
                          aria-label={`删除关键词 ${kw.word}`}
                          title={`删除「${kw.word}」`}
                        >
                          <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
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
