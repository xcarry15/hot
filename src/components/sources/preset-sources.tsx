'use client'

import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { LoadingList } from '@/components/ui/loading-list'
import {
  Plus,
  CheckCircle2,
  Loader2,
  Download,
  Bookmark,
} from 'lucide-react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/ui/empty-state'
import { TYPE_LABELS } from './constants'
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
    const available = presets.filter(p => !p.isAdded)
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

  const addedCount = presets.filter(p => p.isAdded).length
  const availableCount = presets.filter(p => !p.isAdded).length

  if (loading) {
    return <LoadingList count={5} />
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top Bar */}
      <div className="space-y-1.5 border-b p-2">
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
            className="h-7 gap-1.5 px-2.5 text-xs"
          >
            {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            一键添加全部
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <span className="text-xs text-muted-foreground">已选 {selectedIds.size} 项</span>
              <Button
                size="sm"
                onClick={handleAddSelected}
                disabled={adding}
                className="h-7 gap-1.5 px-2.5 text-xs"
              >
                {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                添加选中 ({selectedIds.size})
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={toggleSelectAll}
                className="h-7 px-2 text-xs"
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
              className="h-7 px-2 text-xs"
            >
              全选可用
            </Button>
          )}
        </div>
      </div>

      {/* Preset List */}
      <ScrollArea className="flex-1 h-full">
        {presets.length === 0 ? (
          <EmptyState title="暂无预设源" />
        ) : (
          <div className="space-y-1 p-2">
            {presets.map(preset => (
              <div
                key={preset.id}
                className={`flex min-w-0 items-center gap-2 border px-2 py-1 text-xs transition-colors ${
                  preset.isAdded
                    ? 'border-emerald-200 bg-emerald-50/50'
                    : selectedIds.has(preset.id)
                      ? 'border-primary/30 bg-primary/5'
                      : 'hover:bg-muted/40'
                }`}
              >
                {!preset.isAdded ? (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(preset.id)}
                    onChange={() => toggleSelect(preset.id)}
                    className="h-4 w-4 shrink-0 accent-primary"
                  />
                ) : (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                )}

                <span className={`min-w-0 max-w-32 shrink-0 truncate font-medium sm:max-w-48 ${preset.isAdded ? 'text-emerald-700' : ''}`} title={preset.name}>
                  {preset.name}
                </span>
                <Badge variant="outline" className="h-5 shrink-0 px-1.5 py-0 text-[10px]">
                  {TYPE_LABELS[preset.type] || preset.type}
                </Badge>
                <span className="hidden min-w-0 flex-1 truncate text-[11px] text-muted-foreground md:block" title={preset.description}>
                  {preset.description}
                </span>
                <span className="hidden max-w-[28rem] min-w-0 flex-1 truncate text-[10px] text-muted-foreground/70 lg:block" title={preset.url}>
                  {preset.url}
                </span>
                {preset.isAdded && (
                  <Badge className="h-5 shrink-0 border-emerald-200 bg-emerald-100 px-2 py-0 text-[10px] text-emerald-700">
                    已添加
                  </Badge>
                )}
                {!preset.isAdded && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => handleAddSingle(preset)}
                    disabled={adding}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    添加
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
