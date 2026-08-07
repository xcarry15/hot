'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { fetchSources, updateSource } from '@/features/sources-api.client'
import { previewPublicSettings, type PublicPreviewResult } from '@/features/settings-api.client'
import type { SourceDto } from '@/contracts/sources'
import type { Settings } from './types'

interface Props {
  settings: Settings
  setSettings: React.Dispatch<React.SetStateAction<Settings>>
}

export default function PublicTab({ settings, setSettings }: Props) {
  const [sources, setSources] = useState<SourceDto[]>([])
  const [loadingSources, setLoadingSources] = useState(true)
  const [updatingSourceId, setUpdatingSourceId] = useState<string | null>(null)
  const [preview, setPreview] = useState<PublicPreviewResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const initialPreviewLoaded = useRef(false)

  const publicSourceCount = useMemo(
    () => sources.filter((source) => source.publicEnabled).length,
    [sources],
  )
  const publicSourceArticleCount = useMemo(
    () => sources.reduce((total, source) => total + (source.publicEnabled ? source.articleCount : 0), 0),
    [sources],
  )

  const updateSetting = (key: keyof Settings, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  const previewRules = useCallback(async () => {
    setPreviewing(true)
    try {
      setPreview(await previewPublicSettings({
        minScore: Number(settings.public_min_score) || 0,
        minRelevance: Number(settings.public_min_relevance) || 0,
        hideAds: settings.public_hide_ads !== 'false',
      }))
    } catch {
      toast.error('公开规则预览失败')
    } finally {
      setPreviewing(false)
    }
  }, [settings.public_hide_ads, settings.public_min_relevance, settings.public_min_score])

  useEffect(() => {
    fetchSources()
      .then(setSources)
      .catch(() => toast.error('获取数据源公开状态失败'))
      .finally(() => setLoadingSources(false))
  }, [])

  // 页面打开即展示当前规则的影响范围；阈值编辑后仍由“刷新预览”显式确认，
  // 避免用户输入过程中频繁请求后端。
  useEffect(() => {
    if (initialPreviewLoaded.current) return
    initialPreviewLoaded.current = true
    void previewRules()
  }, [previewRules])

  const toggleSource = async (source: SourceDto) => {
    setUpdatingSourceId(source.id)
    try {
      await updateSource(source.id, { publicEnabled: !source.publicEnabled })
      setSources((prev) => prev.map((item) => (
        item.id === source.id ? { ...item, publicEnabled: !item.publicEnabled } : item
      )))
      if (preview) await previewRules()
    } catch {
      toast.error('更新数据源公开状态失败')
    } finally {
      setUpdatingSourceId(null)
    }
  }

  return (
    <div className="space-y-3 pt-3">
      <div className="flex items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-tight">公开</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            控制哪些内容进入公开端；单篇例外请在工作台的文章抽屉中处理。
          </p>
        </div>
        {preview && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            按当前编辑值预览 · {preview.hideAds ? '隐藏软文' : '允许软文'}
          </span>
        )}
      </div>

      <Card className="gap-0 py-0">
        <CardHeader className="flex flex-row items-center justify-between gap-3 border-b px-3 py-2.5">
          <div className="min-w-0">
            <CardTitle className="text-sm">自动公开规则</CardTitle>
            <p className="mt-1 text-[11px] text-muted-foreground">
              仅对“自动”文章生效；人工公开优先于以下阈值。
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 px-2.5 text-xs"
            onClick={() => void previewRules()}
            disabled={previewing}
          >
            {previewing ? '预览中…' : preview ? '刷新预览' : '查看生效范围'}
          </Button>
        </CardHeader>

        <CardContent className="p-0">
          <div className="grid gap-px bg-border md:grid-cols-3">
            <div className="bg-background px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="public-min-score" className="text-xs">最低评分</Label>
                <Input
                  id="public-min-score"
                  type="number"
                  min={0}
                  max={100}
                  value={settings.public_min_score}
                  onChange={(event) => updateSetting('public_min_score', event.target.value)}
                  className="h-8 w-20 text-center text-xs"
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">0–100，默认 70</p>
            </div>

            <div className="bg-background px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="public-min-relevance" className="text-xs">最低相关度</Label>
                <Input
                  id="public-min-relevance"
                  type="number"
                  min={0}
                  max={100}
                  value={settings.public_min_relevance}
                  onChange={(event) => updateSetting('public_min_relevance', event.target.value)}
                  className="h-8 w-20 text-center text-xs"
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">0–100，默认 50</p>
            </div>

            <div className="bg-background px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="public-hide-ads" className="text-xs">软文处理</Label>
                <Select value={settings.public_hide_ads} onValueChange={(value) => updateSetting('public_hide_ads', value)}>
                  <SelectTrigger id="public-hide-ads" className="h-8 w-28 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-none shadow-sm">
                    <SelectItem value="true">隐藏软文</SelectItem>
                    <SelectItem value="false">允许公开</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">人工公开不受此限制</p>
            </div>
          </div>

          <div className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 text-xs">
            <span className="font-medium">预计范围</span>
            {preview ? (
              <>
                <span className="text-muted-foreground">候选 {preview.candidates} 个事件</span>
                <span className="text-emerald-700">可公开 {preview.wouldPublish}</span>
                <span className="text-muted-foreground">会隐藏 {preview.wouldHide}</span>
              </>
            ) : (
              <span className="text-muted-foreground">点击“查看生效范围”获取当前统计</span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="flex flex-row items-center justify-between gap-3 border-b px-3 py-2.5">
          <div className="min-w-0">
            <CardTitle className="text-sm">公开来源</CardTitle>
            <p className="mt-1 text-[11px] text-muted-foreground">
              关闭后仍会抓取和分析，只是不进入公开端。
            </p>
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {loadingSources ? '读取中…' : `${publicSourceCount} / ${sources.length} 个来源 · ${publicSourceArticleCount} 篇文章`}
          </span>
        </CardHeader>

        <CardContent className="p-0">
          {loadingSources ? (
            <div className="space-y-px bg-border">
              <Skeleton className="h-12 w-full rounded-none" />
              <Skeleton className="h-12 w-full rounded-none" />
            </div>
          ) : sources.length === 0 ? (
            <p className="px-3 py-5 text-xs text-muted-foreground">暂无数据源，请先在“源管理”中添加。</p>
          ) : (
            <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
              {sources.map((source) => {
                return (
                  <div key={source.id} className="flex min-h-14 items-center justify-between gap-3 bg-background px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{source.name}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {source.articleCount} 篇文章 · {source.publicEnabled ? '允许公开' : '仅抓取分析'}
                      </p>
                    </div>
                    <Switch
                      checked={source.publicEnabled}
                      onCheckedChange={() => void toggleSource(source)}
                      disabled={updatingSourceId !== null}
                      aria-label={`${source.name}公开开关`}
                      className="scale-75"
                    />
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
