'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
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
  const [preview, setPreview] = useState<PublicPreviewResult | null>(null)
  const [previewing, setPreviewing] = useState(false)

  useEffect(() => {
    fetchSources().then(setSources).catch(() => toast.error('获取数据源公开状态失败')).finally(() => setLoadingSources(false))
  }, [])

  const updateSetting = (key: keyof Settings, value: string) => setSettings((prev) => ({ ...prev, [key]: value }))
  const toggleSource = async (source: SourceDto) => {
    try {
      await updateSource(source.id, { publicEnabled: !source.publicEnabled })
      setSources((prev) => prev.map((item) => item.id === source.id ? { ...item, publicEnabled: !item.publicEnabled } : item))
    } catch {
      toast.error('更新数据源公开状态失败')
    }
  }

  const previewRules = async () => {
    setPreviewing(true)
    try {
      setPreview(await previewPublicSettings({ minScore: Number(settings.public_min_score) || 0, hideAds: settings.public_hide_ads !== 'false' }))
    } catch { toast.error('公开规则预览失败') } finally { setPreviewing(false) }
  }

  return (
    <div className="max-w-3xl space-y-3 pt-3 sm:pt-4">
      <Card className="py-0">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">公开展示规则</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-2 space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            公开端只展示 AI 已完成、来源允许公开且符合规则的文章。单篇人工覆盖优先于自动规则。
          </p>
          <div className="flex items-center gap-3">
            <Label htmlFor="public-min-score" className="text-sm whitespace-nowrap">公开最低评分</Label>
            <Input
              id="public-min-score"
              type="number"
              min={0}
              max={100}
              value={settings.public_min_score}
              onChange={(event) => setSettings((prev) => ({ ...prev, public_min_score: event.target.value }))}
              className="h-9 w-24 text-sm"
            />
            <span className="text-xs text-muted-foreground">范围 0–100，默认 70</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-sm">软文处理</Label>
              <Select value={settings.public_hide_ads} onValueChange={(value) => updateSetting('public_hide_ads', value)}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="true">隐藏软文</SelectItem><SelectItem value="false">允许公开</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">重要文章置顶时长</Label>
              <div className="flex items-center gap-2"><Input type="number" min={1} max={720} value={settings.public_pin_hours} onChange={(event) => updateSetting('public_pin_hours', event.target.value)} className="h-9 w-24 text-sm" /><span className="text-xs text-muted-foreground">小时</span></div>
            </div>
          </div>
          <div className="space-y-2 border-t pt-3">
            <div><p className="text-sm font-medium">人工归类与公开映射</p><p className="text-xs text-muted-foreground">归类后单篇覆盖自动规则；重要文章默认公开并置顶。</p></div>
            <div className="grid gap-2 sm:grid-cols-3">
              {([
                ['important', '重要（固定公开）', 'public_important_rule'],
                ['general', '一般', 'public_general_rule'],
                ['irrelevant', '无关', 'public_irrelevant_rule'],
              ] as const).map(([, label, key]) => (
                <div key={key} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <span className="text-xs font-medium">{label}</span>
                  <Select value={key === 'public_important_rule' ? 'public' : settings[key]} onValueChange={(value) => updateSetting(key, value)} disabled={key === 'public_important_rule'}>
                    <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="auto">自动</SelectItem><SelectItem value="public">公开</SelectItem><SelectItem value="hidden">隐藏</SelectItem></SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <button type="button" onClick={() => void previewRules()} disabled={previewing} className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-60">{previewing ? '预览中…' : '预览公开结果'}</button>
            {preview && <span className="text-xs text-muted-foreground">当前约 {preview.wouldPublish} 篇可公开，{preview.wouldHide} 篇会被隐藏（候选 {preview.candidates} 篇）</span>}
          </div>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="p-4 pb-2"><CardTitle className="text-sm">数据源公开开关</CardTitle></CardHeader>
        <CardContent className="p-4 pt-2 space-y-2">
          <p className="text-xs text-muted-foreground">关闭后该来源的文章仍会抓取和分析，但不进入公开端。</p>
          {loadingSources ? <Skeleton className="h-10 w-full" /> : sources.length === 0 ? <p className="py-3 text-xs text-muted-foreground">暂无数据源</p> : (
            <div className="divide-y rounded-md border">
              {sources.map((source) => <div key={source.id} className="flex items-center justify-between gap-3 px-3 py-2"><div className="min-w-0"><p className="truncate text-sm">{source.name}</p><p className="text-[11px] text-muted-foreground">{source.articleCount} 篇文章</p></div><Switch checked={source.publicEnabled} onCheckedChange={() => toggleSource(source)} aria-label={`${source.name}公开开关`} /></div>)}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
