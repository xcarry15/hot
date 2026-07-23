'use client'

import { useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
  Download,
  FileUp,
  MessageSquareText,
  RefreshCcw,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  DEFAULT_SYSTEM_PROMPT,
  PROMPT_BLOCK_META,
  PROMPT_BLOCK_ORDER,
  SCORE_WEIGHT_META,
  PromptBlockId,
  PromptBlockKey,
} from '@/lib/prompts'
import { Settings } from './types'
import { previewScoreSettings } from '@/features/settings-api.client'

interface Props {
  settings: Settings
  setSettings: React.Dispatch<React.SetStateAction<Settings>>
  onImportPrompts: (patch: Partial<Settings>) => Promise<void>
  saving: boolean
}

type PromptBackupKey = 'ai_system_prompt' | PromptBlockKey

interface PromptBackupPayload {
  type: 'hot2-prompt-backup'
  version: 1
  exportedAt: string
  prompts: Partial<Record<PromptBackupKey, string>>
}

function isPromptBackupKey(value: string): value is PromptBackupKey {
  return value === 'ai_system_prompt' || PROMPT_BLOCK_ORDER.some((blockId) => PROMPT_BLOCK_META[blockId].key === value)
}

export default function PromptsTab({ settings, setSettings, onImportPrompts, saving }: Props) {
  const [resetDialog, setResetDialog] = useState<{ onConfirm: () => void } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<{ total: number; changed: number; increased: number; decreased: number; samples: { id: string; title: string; before: number; after: number; delta: number }[] } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const updateSetting = (key: keyof Settings, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }))
  }

  const resetBlock = (blockId: PromptBlockId) => {
    const meta = PROMPT_BLOCK_META[blockId]
    setSettings(prev => ({ ...prev, [meta.key]: meta.defaultBlock }))
    toast.info('已恢复为默认提示词，保存后生效')
  }

  const resetSystem = () => {
    setSettings(prev => ({ ...prev, ai_system_prompt: DEFAULT_SYSTEM_PROMPT }))
    toast.info('已恢复为默认系统角色，保存后生效')
  }

  const exportPrompts = () => {
    const prompts: Partial<Record<PromptBackupKey, string>> = {
      ai_system_prompt: settings.ai_system_prompt || DEFAULT_SYSTEM_PROMPT,
    }
    for (const blockId of PROMPT_BLOCK_ORDER) {
      const meta = PROMPT_BLOCK_META[blockId]
      prompts[meta.key] = settings[meta.key] || meta.defaultBlock
    }

    const payload: PromptBackupPayload = {
      type: 'hot2-prompt-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      prompts,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `hot2-prompts-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.json`
    link.click()
    URL.revokeObjectURL(url)
    toast.success('提示词已导出')
  }

  const importPrompts = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 1_000_000) {
      toast.error('文件过大，请确认是否为提示词备份文件')
      return
    }

    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!parsed || typeof parsed !== 'object') throw new Error('文件格式无效')
      const backup = parsed as Partial<PromptBackupPayload>
      if (backup.type !== 'hot2-prompt-backup' || backup.version !== 1 || !backup.prompts || typeof backup.prompts !== 'object') {
        throw new Error('不是有效的提示词备份文件')
      }

      const imported: Partial<Settings> = {}
      for (const [key, value] of Object.entries(backup.prompts)) {
        if (isPromptBackupKey(key) && typeof value === 'string') imported[key] = value
      }
      if (Object.keys(imported).length === 0) throw new Error('备份文件中没有可识别的提示词')

      await onImportPrompts(imported)
      toast.success(`已导入并保存 ${Object.keys(imported).length} 项提示词，已立即生效`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入提示词失败')
    }
  }

  const resetAllPrompts = () => {
    setSettings(prev => ({
      ...prev,
      ai_system_prompt: DEFAULT_SYSTEM_PROMPT,
      ai_block_ad: PROMPT_BLOCK_META.ad.defaultBlock,
      ai_block_event_identity: PROMPT_BLOCK_META.eventIdentity.defaultBlock,
      ai_block_key_points: PROMPT_BLOCK_META.keyPoints.defaultBlock,
      ai_block_summary: PROMPT_BLOCK_META.summary.defaultBlock,
      ai_block_event_score: PROMPT_BLOCK_META.eventScore.defaultBlock,
      ai_block_content_score: PROMPT_BLOCK_META.contentScore.defaultBlock,
      ai_block_category: PROMPT_BLOCK_META.category.defaultBlock,
      ai_block_relevance: PROMPT_BLOCK_META.relevance.defaultBlock,
      ai_block_brand: PROMPT_BLOCK_META.brand.defaultBlock,
      ai_weight_event: String(SCORE_WEIGHT_META.event.defaultWeight),
      ai_weight_content: String(SCORE_WEIGHT_META.content.defaultWeight),
      ai_keyword_match_bonus: '5',
      ai_step2_content_max_chars: '5000',
    }))
  }

  // 用 Number 而非 parseInt:parseInt('33.3')===33 会让 UI 显示假绿(输入小数时合计
  // 被截成 100),而服务端 schema /^\d+$/ 会拒掉小数导致整批 PUT 失败、用户只看到
  // 「保存失败」找不到原因。这里展示真实合计,配合下方输入框过滤非整数,两边一致。
  const weightTotal =
    (Number(settings.ai_weight_event) || 0) +
    (Number(settings.ai_weight_content) || 0)
  const weightSumInvalid = weightTotal !== 100
  const systemIsDefault = !settings.ai_system_prompt || settings.ai_system_prompt === DEFAULT_SYSTEM_PROMPT

  const previewPolicy = async () => {
    setPreviewing(true)
    try {
      const data = await previewScoreSettings({
        weightEvent: Number(settings.ai_weight_event),
        weightContent: Number(settings.ai_weight_content),
        keywordBonus: Number(settings.ai_keyword_match_bonus),
      })
      setPreview(data)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '预演失败')
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <>
      <Card className="mt-2 py-0">
        <CardContent className="space-y-2.5 p-3">
          <div className="flex flex-wrap items-center gap-2 border-b pb-2">
            <MessageSquareText className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">提示词</span>
            <span className="text-xs text-muted-foreground">— 手动编辑需点底部「保存设置」；导入会自动保存</span>
            <div className="ml-auto flex flex-wrap items-center gap-1">
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={exportPrompts}>
                <Download className="h-3 w-3" />
                一键导出
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => fileInputRef.current?.click()} disabled={saving}>
                <FileUp className="h-3 w-3" />
                一键导入
              </Button>
              <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={importPrompts} className="hidden" />
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setResetDialog({ onConfirm: resetAllPrompts })}>
                <RefreshCcw className="h-3 w-3" />
                恢复默认
              </Button>
            </div>
          </div>

          <div className="space-y-1.5 border p-2.5">
            <p className="text-xs font-medium">当前生效的代码护栏</p>
            <div className="grid gap-x-4 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-2">
              <p>• event_score ≤ 9：标记为无具体事件，不进入 Event 聚类。</p>
              <p>• 标题包含多个独立事件：不自动合并，保留为正常跳过。</p>
              <p>• 聚类时间信号：常规 7 天；跟进候选最多召回 14 天。</p>
              <p>• eventKey 由主体 / 原子动作 / 辨识事项确定性生成，brand 不覆盖事件主体。</p>
              <p>• 广告概率 ≤ 20 不扣分；达到 50 后进入广告封顶，硬事实高分稿封顶 70，其余封顶 45。</p>
              <p>• 关键词加分在广告规则之后执行，最终分数封顶 100。</p>
              <p>• 劳动保障事实仅在模型已判广告时触发非广告兜底，避免单个关键词洗掉宣传稿。</p>
              <p>• 正文、AI、聚类和推送失败均有限次自动重试，耗尽后转人工处理。</p>
            </div>
            <p className="text-[11px] text-muted-foreground">以上属于防止误聚类、误公开和误评分的安全约束；可运营参数请在本页、AI 模型和推送页调整。</p>
          </div>

          {/* 评分权重 */}
          <div className="space-y-2 border p-2.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">评分权重 <span className="text-muted-foreground">(满分 100)</span></Label>
              <span className={`text-xs tabular-nums ${weightSumInvalid ? 'text-amber-600' : 'text-muted-foreground'}`}>
                {weightSumInvalid ? `合计 ${weightTotal} ⚠️` : `合计 ${weightTotal}`}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(['event', 'content'] as const).map(kind => {
                const meta = SCORE_WEIGHT_META[kind]
                return (
                  <div key={kind} className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{meta.label}</Label>
                    <Input type="number" value={settings[meta.key]} onChange={(e) => updateSetting(meta.key, e.target.value.replace(/[^\d]/g, ''))} className="h-8 text-xs" min="0" max="100" step="1" />
                  </div>
                )
              })}
            </div>
            <div className="grid grid-cols-[1fr_120px] items-end gap-2 border-t pt-2">
              <div>
                <Label className="text-xs">关键词命中加分</Label>
                <p className="mt-1 text-[11px] text-muted-foreground">命中已配置关键词时追加到最终分，不改变 AI 原始事件分和内容分。</p>
              </div>
              <Input type="number" value={settings.ai_keyword_match_bonus} onChange={(e) => updateSetting('ai_keyword_match_bonus', e.target.value.replace(/[^\d]/g, ''))} className="h-8 text-xs" min="0" max="20" step="1" />
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={previewPolicy} disabled={previewing || weightSumInvalid}>
                {previewing ? '预演中…' : '预演历史文章'}
              </Button>
              {preview && (
                <span className="text-[11px] text-muted-foreground">
                  覆盖 {preview.total} 篇，变化 {preview.changed} 篇（↑{preview.increased} / ↓{preview.decreased}）
                </span>
              )}
            </div>
            {preview && preview.samples.length > 0 && (
              <div className="max-h-[240px] space-y-1 overflow-y-auto border text-xs">
                <div className="grid grid-cols-[1fr_56px_56px_56px] gap-1 px-2 py-1 bg-muted/50 text-muted-foreground font-medium">
                  <span>文章标题</span>
                  <span className="text-center">原分</span>
                  <span className="text-center">新分</span>
                  <span className="text-center">变化</span>
                </div>
                {preview.samples.map(s => (
                  <div key={s.id} className="grid grid-cols-[1fr_56px_56px_56px] gap-1 px-2 py-0.5 items-center">
                    <span className="truncate">{s.title}</span>
                    <span className="text-center tabular-nums text-muted-foreground">{s.before}</span>
                    <span className="text-center tabular-nums">{s.after}</span>
                    <span className={`text-center tabular-nums font-medium ${s.delta > 0 ? 'text-emerald-600' : s.delta < 0 ? 'text-red-600' : 'text-muted-foreground'}`}>
                      {s.delta > 0 ? `↑${s.delta}` : s.delta < 0 ? `↓${Math.abs(s.delta)}` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">{weightSumInvalid ? `权重合计必须为 100，当前 ${weightTotal}。` : '保存后立即重算已有原始子分的文章，无需再次调用 AI。'}</p>
          </div>

          {/* AI 输入长度限制 */}
          <div className="space-y-1">
            <Label className="text-xs">正文最大长度 <span className="text-muted-foreground">(500-10000)</span></Label>
            <Input type="number" value={settings.ai_step2_content_max_chars} onChange={(e) => updateSetting('ai_step2_content_max_chars', e.target.value.replace(/[^\d]/g, ''))} className="h-8 text-xs w-32" min="500" max="10000" placeholder="5000" />
          </div>

          {/* 系统角色 */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <MessageSquareText className="h-3.5 w-3.5 text-muted-foreground" />
              <Label className="text-xs">系统角色 <span className="text-muted-foreground">(System)</span></Label>
              {systemIsDefault && <span className="bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">默认</span>}
              <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px] ml-auto gap-1" onClick={resetSystem} disabled={systemIsDefault}>
                <RefreshCcw className="h-3 w-3" />恢复
              </Button>
            </div>
            <Textarea value={settings.ai_system_prompt || DEFAULT_SYSTEM_PROMPT} onChange={(e) => updateSetting('ai_system_prompt', e.target.value)} className="text-xs min-h-[120px] max-h-[240px] !field-sizing-fixed resize-y overflow-y-auto" />
          </div>

          {/* 评判块 */}
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">下列 9 个块只描述各字段的判断标准；执行顺序、事件键拼装、证据边界和 JSON 结构由代码统一维护。</p>
            {PROMPT_BLOCK_ORDER.map((blockId) => {
              const meta = PROMPT_BLOCK_META[blockId]
              const isCustom = !!settings[meta.key] && settings[meta.key] !== meta.defaultBlock
              return (
                <div key={blockId} className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium">{meta.label}</span>
                    {!isCustom && <span className="bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">默认</span>}
                    <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px] ml-auto gap-1" onClick={() => resetBlock(blockId)} disabled={!isCustom}>
                      <RefreshCcw className="h-3 w-3" />恢复
                    </Button>
                  </div>
                  <Textarea value={settings[meta.key] || meta.defaultBlock} onChange={(e) => updateSetting(meta.key as keyof Settings, e.target.value)} className="text-xs min-h-[120px] max-h-[280px] !field-sizing-fixed resize-y overflow-y-auto font-mono" />
                  <p className="text-[11px] text-muted-foreground">{meta.scoreHint}</p>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={!!resetDialog} onOpenChange={(open) => !open && setResetDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认恢复全部提示词为默认值？</AlertDialogTitle>
            <AlertDialogDescription>
              系统角色、9 个评判块、评分权重都会重置，保存后生效。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                resetDialog?.onConfirm()
                setResetDialog(null)
                toast.success('已恢复全部提示词为默认值,保存后生效')
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              确认恢复
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
