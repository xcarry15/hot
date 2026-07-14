'use client'

import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { LoadingList } from '@/components/ui/loading-list'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Plus,
  CheckCircle2,
  Loader2,
  Download,
  Bookmark,
} from 'lucide-react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/ui/empty-state'
import { CATEGORY_ICONS, TYPE_LABELS } from './constants'
import type { PresetSourceItem } from './types'
import {
  addPresetSource as addPresetSourceApi,
  fetchPresetSources,
} from '@/features/sources-api.client'

// ========== Preset Sources Management ==========

export function PresetSourcesManagement() {
  const [presets, setPresets] = useState<PresetSourceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [adding, setAdding] = useState(false)

  const loadPresets = useCallback(async () => {
    try {
      const data = await fetchPresetSources()
      setPresets(data as unknown as PresetSourceItem[])
    } catch {
      toast.error('获取预设源失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const handle = setTimeout(loadPresets, 0)
    return () => clearTimeout(handle)
  }, [loadPresets])

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleSelectAll = () => {
    const available = filteredPresets.filter(p => !p.isAdded)
    const allAvailableSelected = available.every(p => selectedIds.has(p.id))
    if (allAvailableSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(available.map(p => p.id)))
    }
  }

  const handleAddSelected = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要添加的预设源')
      return
    }
    setAdding(true)
    try {
      const result = (await addPresetSourceApi({ presetIds: Array.from(selectedIds) })) as {
        added: number;
        skipped: number;
      }
      if (result.added > 0) {
        toast.success(`成功添加 ${result.added} 个数据源${result.skipped > 0 ? `，跳过 ${result.skipped} 个已存在` : ''}`)
      } else {
        toast.info('所有选中的预设源已存在')
      }
      setSelectedIds(new Set())
      loadPresets()
    } catch {
      toast.error('添加预设源失败')
    } finally {
      setAdding(false)
    }
  }

  const handleAddAll = async () => {
    setAdding(true)
    try {
      const result = (await addPresetSourceApi({ addAll: true })) as {
        added: number;
        skipped: number;
      }
      if (result.added > 0) {
        toast.success(`成功添加 ${result.added} 个数据源${result.skipped > 0 ? `，跳过 ${result.skipped} 个已存在` : ''}`)
      } else {
        toast.info('所有预设源已存在')
      }
      loadPresets()
    } catch {
      toast.error('添加预设源失败')
    } finally {
      setAdding(false)
    }
  }

  const handleAddSingle = async (preset: PresetSourceItem) => {
    setAdding(true)
    try {
      const result = (await addPresetSourceApi({ presetIds: [preset.id] })) as {
        added: number;
      }
      if (result.added > 0) {
        toast.success(`已添加「${preset.name}」`)
      } else {
        toast.info(`「${preset.name}」已存在`)
      }
      loadPresets()
    } catch {
      toast.error('添加失败')
    } finally {
      setAdding(false)
    }
  }

  const filteredPresets = presets.filter(p => {
    if (categoryFilter !== 'all' && p.category !== categoryFilter) return false
    return true
  })

  const grouped = filteredPresets.reduce<Record<string, PresetSourceItem[]>>((acc, p) => {
    if (!acc[p.category]) acc[p.category] = []
    acc[p.category].push(p)
    return acc
  }, {})

  const categoryOrder = ['餐饮', '零售', '食品', '品牌', '综合']
  const sortedCategories = Object.keys(grouped).sort(
    (a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b)
  )

  const addedCount = presets.filter(p => p.isAdded).length
  const availableCount = presets.filter(p => !p.isAdded).length

  if (loading) {
    return <LoadingList count={5} />
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top Bar */}
      <div className="p-2 border-b space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bookmark className="h-4 w-4" />
            <span>预设源库</span>
            <Badge variant="secondary" className="text-xs px-2 py-0">{presets.length}</Badge>
            <span className="text-emerald-600 font-medium">{addedCount} 已添加</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-amber-600 font-medium">{availableCount} 可用</span>
          </div>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            onClick={handleAddAll}
            disabled={adding || availableCount === 0}
            className="gap-1.5 h-8 px-3 text-xs"
          >
            {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            一键添加全部
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue placeholder="分类" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部分类</SelectItem>
              {categoryOrder.map(c => (
                <SelectItem key={c} value={c}>{CATEGORY_ICONS[c]} {c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedIds.size > 0 && (
            <>
              <span className="text-xs text-muted-foreground">已选 {selectedIds.size} 项</span>
              <Button
                size="sm"
                onClick={handleAddSelected}
                disabled={adding}
                className="gap-1.5 h-8 px-3 text-xs"
              >
                {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                添加选中 ({selectedIds.size})
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={toggleSelectAll}
                className="h-8 px-2 text-xs"
              >
                全选/取消
              </Button>
            </>
          )}
          {selectedIds.size === 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={toggleSelectAll}
              className="h-8 px-2 text-xs"
            >
              全选可用
            </Button>
          )}
        </div>
      </div>

      {/* Preset List */}
      <ScrollArea className="flex-1 h-full">
        {sortedCategories.length === 0 ? (
          <EmptyState title="暂无预设源" />
        ) : (
          <div className="p-2 space-y-2">
            {sortedCategories.map(category => (
              <div key={category}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-base">{CATEGORY_ICONS[category] || '📌'}</span>
                  <span className="text-sm font-semibold">{category}</span>
                  <Badge variant="secondary" className="text-xs px-2 py-0">
                    {grouped[category].filter(p => p.isAdded).length}/{grouped[category].length}
                  </Badge>
                </div>
                <div className="space-y-1">
                  {grouped[category].map(preset => (
                    <div
                      key={preset.id}
                      className={`border rounded-md p-2 text-sm transition-colors ${
                        preset.isAdded
                          ? 'bg-emerald-50/50 border-emerald-200'
                          : selectedIds.has(preset.id)
                            ? 'bg-primary/5 border-primary/30'
                            : 'hover:bg-muted/40'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {!preset.isAdded && (
                          <input
                            type="checkbox"
                            checked={selectedIds.has(preset.id)}
                            onChange={() => toggleSelect(preset.id)}
                            className="h-4 w-4 shrink-0 accent-primary"
                          />
                        )}
                        {preset.isAdded && (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                        )}

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`font-medium truncate ${preset.isAdded ? 'text-emerald-700' : ''}`}>
                              {preset.name}
                            </span>
                            <Badge variant="outline" className="text-xs px-1.5 py-0 h-5">
                              {TYPE_LABELS[preset.type] || preset.type}
                            </Badge>
                            {preset.isAdded && (
                              <Badge className="text-xs px-2 py-0 h-5 bg-emerald-100 text-emerald-700 border-emerald-200">
                                已添加
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground truncate mt-1">
                            {preset.description}
                          </div>
                          <div className="text-xs text-muted-foreground/70 truncate">
                            {preset.url}
                          </div>
                        </div>

                        {/* Action */}
                        {!preset.isAdded && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs px-2.5 shrink-0"
                            onClick={() => handleAddSingle(preset)}
                            disabled={adding}
                          >
                            <Plus className="h-3.5 w-3.5 mr-1" />
                            添加
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
