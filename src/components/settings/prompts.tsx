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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Download,
  FileUp,
  History,
  MessageSquareText,
  RefreshCcw,
  Save,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  DEFAULT_SYSTEM_PROMPT,
  PROMPT_BLOCK_META,
  PROMPT_BLOCK_ORDER,
  PROMPT_VERSION_KEYS,
  PROMPT_VERSION_LIMIT,
  SCORE_WEIGHT_META,
  PromptBlockId,
  PromptBlockKey,
  type PromptVersionKey,
  type PromptVersionSnapshot,
} from '@/lib/prompts'
import { comparePromptSnapshots } from '@/lib/prompt-diff'
import { Settings } from './types'
import {
  createPromptVersion,
  deletePromptVersion,
  fetchPromptVersions,
  previewScoreSettings,
  type PromptVersion,
} from '@/features/settings-api.client'

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
  sourceVersion?: {
    id: string
    name: string
    createdAt: string
  }
  prompts: Partial<Record<PromptBackupKey, string>>
}

function isPromptBackupKey(value: string): value is PromptBackupKey {
  return value === 'ai_system_prompt' || PROMPT_BLOCK_ORDER.some((blockId) => PROMPT_BLOCK_META[blockId].key === value)
}

function buildPromptVersionSnapshot(settings: Settings): PromptVersionSnapshot {
  const prompts = {
    ai_system_prompt: settings.ai_system_prompt || DEFAULT_SYSTEM_PROMPT,
  } as PromptVersionSnapshot
  for (const blockId of PROMPT_BLOCK_ORDER) {
    const meta = PROMPT_BLOCK_META[blockId]
    prompts[meta.key as PromptVersionKey] = settings[meta.key] || meta.defaultBlock
  }
  return prompts
}

function formatVersionTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function promptVersionLabel(key: PromptVersionKey): string {
  if (key === 'ai_system_prompt') return '系统角色'
  const blockId = PROMPT_BLOCK_ORDER.find((id) => PROMPT_BLOCK_META[id].key === key)
  return blockId ? PROMPT_BLOCK_META[blockId].label : key
}

function safeFileNamePart(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || '未命名版本'
}

export default function PromptsTab({ settings, setSettings, onImportPrompts, saving }: Props) {
  const [resetDialog, setResetDialog] = useState<{ onConfirm: () => void } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<{ total: number; changed: number; increased: number; decreased: number; samples: { id: string; title: string; before: number; after: number; delta: number }[] } | null>(null)
  const [versionDialogOpen, setVersionDialogOpen] = useState(false)
  const [versions, setVersions] = useState<PromptVersion[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionSaving, setVersionSaving] = useState(false)
  const [versionName, setVersionName] = useState('')
  const [versionToLoad, setVersionToLoad] = useState<PromptVersion | null>(null)
  const [versionToCompare, setVersionToCompare] = useState<PromptVersion | null>(null)
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

  const loadVersions = async () => {
    setVersionsLoading(true)
    try {
      setVersions(await fetchPromptVersions())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '获取提示词版本失败')
    } finally {
      setVersionsLoading(false)
    }
  }

  const openVersionDialog = () => {
    setVersionDialogOpen(true)
    void loadVersions()
  }

  const savePromptVersion = async () => {
    const name = versionName.trim()
    if (!name) {
      toast.error('请填写版本名称')
      return
    }
    setVersionSaving(true)
    try {
      const version = await createPromptVersion({ name, prompts: buildPromptVersionSnapshot(settings) })
      setVersions(current => [version, ...current].slice(0, PROMPT_VERSION_LIMIT))
      setVersionName('')
      toast.success('提示词版本已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存提示词版本失败')
    } finally {
      setVersionSaving(false)
    }
  }

  const loadPromptVersion = (version: PromptVersion) => {
    setSettings(current => ({ ...current, ...version.prompts }))
    setVersionToLoad(null)
    setVersionDialogOpen(false)
    toast.success(`已载入「${version.name}」，请点击底部「保存设置」后生效`)
  }

  const openPromptComparison = (version: PromptVersion) => {
    setVersionDialogOpen(false)
    setVersionToCompare(version)
  }

  const removePromptVersion = async (id: string) => {
    try {
      await deletePromptVersion(id)
      setVersions(current => current.filter(version => version.id !== id))
      toast.success('提示词版本已删除')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除提示词版本失败')
    }
  }

  const downloadPromptBackup = (prompts: PromptVersionSnapshot, fileName: string, sourceVersion?: PromptVersion) => {
    const payload: PromptBackupPayload = {
      type: 'hot2-prompt-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      prompts,
    }
    if (sourceVersion) {
      payload.sourceVersion = {
        id: sourceVersion.id,
        name: sourceVersion.name,
        createdAt: sourceVersion.createdAt,
      }
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    URL.revokeObjectURL(url)
  }

  const exportPrompts = () => {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    downloadPromptBackup(buildPromptVersionSnapshot(settings), `hot2-prompts-current-${date}.json`)
    toast.success('当前提示词已导出')
  }

  const exportPromptVersion = (version: PromptVersion) => {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    downloadPromptBackup(version.prompts, `hot2-prompts-${safeFileNamePart(version.name)}-${date}.json`, version)
    toast.success(`已导出提示词版本「${version.name}」`)
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
  const promptComparison = versionToCompare
    ? comparePromptSnapshots(buildPromptVersionSnapshot(settings), versionToCompare.prompts)
    : []

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
        <CardContent className="space-y-2 p-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b pb-1.5">
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
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={openVersionDialog}>
                <History className="h-3 w-3" />
                版本管理
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setResetDialog({ onConfirm: resetAllPrompts })}>
                <RefreshCcw className="h-3 w-3" />
                恢复默认
              </Button>
            </div>
          </div>

          <details className="group border px-2.5 py-1.5">
            <summary className="flex cursor-pointer list-none items-center justify-between text-[11px] text-muted-foreground">
              <span>当前生效的代码护栏</span>
              <span className="group-open:hidden">展开</span>
              <span className="hidden group-open:inline">收起</span>
            </summary>
            <div className="mt-1.5 grid gap-x-4 gap-y-1 border-t pt-1.5 text-[11px] text-muted-foreground sm:grid-cols-2">
              <p>• event_score 只表示事件影响力；低分的具体事实仍可进入 Event 聚类。</p>
              <p>• 无完整事件身份但相关度、内容分足够高：自动建立独立 Event，不会直接丢弃或进入人工校准。</p>
              <p>• 聚类时间信号：常规 7 天；跟进候选最多召回 14 天。</p>
              <p>• eventKey 由主体 / 原子动作 / 辨识事项确定性生成，brand 不覆盖事件主体。</p>
              <p>• 每篇文章只调用一次 AI；归并只使用结构化身份和本地证据，不再二次请求 AI。</p>
              <p>• 广告概率 ≤ 20 不扣分；达到 50 后进入广告封顶，硬事实高分稿封顶 70，其余封顶 45。</p>
              <p>• 关键词加分在广告规则之后执行，最终分数封顶 100。</p>
              <p>• 劳动保障事实仅在模型已判广告时触发非广告兜底，避免单个关键词洗掉宣传稿。</p>
              <p>• 正文、AI、聚类和推送失败均有限次自动重试，耗尽后转人工处理。</p>
            </div>
          </details>

          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_180px]">
            {/* 评分权重 */}
            <div className="space-y-1.5 border p-2.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs">评分权重 <span className="text-muted-foreground">(满分 100)</span></Label>
                <span className={`text-xs tabular-nums ${weightSumInvalid ? 'text-amber-600' : 'text-muted-foreground'}`}>
                  {weightSumInvalid ? `合计 ${weightTotal} ⚠️` : `合计 ${weightTotal}`}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(['event', 'content'] as const).map(kind => {
                  const meta = SCORE_WEIGHT_META[kind]
                  return (
                    <div key={kind} className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">{meta.label}</Label>
                      <Input type="number" value={settings[meta.key]} onChange={(e) => updateSetting(meta.key, e.target.value.replace(/[^\d]/g, ''))} className="h-7 text-xs" min="0" max="100" step="1" />
                    </div>
                  )
                })}
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">关键词加分</Label>
                  <Input type="number" value={settings.ai_keyword_match_bonus} onChange={(e) => updateSetting('ai_keyword_match_bonus', e.target.value.replace(/[^\d]/g, ''))} className="h-7 text-xs" min="0" max="20" step="1" />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-1.5">
                <Button type="button" variant="outline" size="sm" className="h-6 text-[11px]" onClick={previewPolicy} disabled={previewing || weightSumInvalid}>
                  {previewing ? '预演中…' : '预演历史文章'}
                </Button>
                {preview && (
                  <span className="text-[11px] text-muted-foreground">
                    覆盖 {preview.total} 篇，变化 {preview.changed} 篇（↑{preview.increased} / ↓{preview.decreased}）
                  </span>
                )}
                <span className="text-[11px] text-muted-foreground">{weightSumInvalid ? `合计需为 100，当前 ${weightTotal}` : '保存后重算已有原始子分，无需再次调用 AI。'}</span>
              </div>
              {preview && preview.samples.length > 0 && (
                <div className="max-h-[180px] space-y-1 overflow-y-auto border text-xs">
                  <div className="grid grid-cols-[1fr_56px_56px_56px] gap-1 bg-muted/50 px-2 py-1 font-medium text-muted-foreground">
                    <span>文章标题</span>
                    <span className="text-center">原分</span>
                    <span className="text-center">新分</span>
                    <span className="text-center">变化</span>
                  </div>
                  {preview.samples.map(s => (
                    <div key={s.id} className="grid grid-cols-[1fr_56px_56px_56px] items-center gap-1 px-2 py-0.5">
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
            </div>

            <div className="space-y-1.5 border p-2.5">
              <Label className="text-xs">正文最大长度 <span className="text-muted-foreground">(500-10000)</span></Label>
              <Input type="number" value={settings.ai_step2_content_max_chars} onChange={(e) => updateSetting('ai_step2_content_max_chars', e.target.value.replace(/[^\d]/g, ''))} className="h-7 text-xs" min="500" max="10000" placeholder="5000" />
              <p className="text-[11px] leading-4 text-muted-foreground">控制单篇送入 AI 的正文长度，默认 5000 字符。</p>
            </div>
          </div>

          {/* 系统角色 */}
          <div className="space-y-1.5 border p-2.5">
            <div className="flex items-center gap-2">
              <MessageSquareText className="h-3.5 w-3.5 text-muted-foreground" />
              <Label className="text-xs">系统角色 <span className="text-muted-foreground">(System)</span></Label>
              {systemIsDefault && <span className="bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">默认</span>}
              <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px] ml-auto gap-1" onClick={resetSystem} disabled={systemIsDefault}>
                <RefreshCcw className="h-3 w-3" />恢复
              </Button>
            </div>
            <Textarea value={settings.ai_system_prompt || DEFAULT_SYSTEM_PROMPT} onChange={(e) => updateSetting('ai_system_prompt', e.target.value)} className="min-h-[96px] max-h-[200px] text-xs !field-sizing-fixed resize-y overflow-y-auto" />
          </div>

          {/* 评判块 */}
          <div className="space-y-1.5">
            <p className="text-[11px] text-muted-foreground">9 个评判块只描述字段判断标准；执行顺序、事件键和 JSON 结构由代码维护。</p>
            {PROMPT_BLOCK_ORDER.map((blockId) => {
              const meta = PROMPT_BLOCK_META[blockId]
              const isCustom = !!settings[meta.key] && settings[meta.key] !== meta.defaultBlock
              return (
                <div key={blockId} className="space-y-1 border p-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="text-xs font-medium">{meta.label}</span>
                    {!isCustom && <span className="bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">默认</span>}
                    <span className="hidden min-w-0 truncate text-[11px] text-muted-foreground sm:block" title={meta.scoreHint}>{meta.scoreHint}</span>
                    <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 shrink-0 gap-1 px-2 text-[11px]" onClick={() => resetBlock(blockId)} disabled={!isCustom}>
                      <RefreshCcw className="h-3 w-3" />恢复
                    </Button>
                  </div>
                  <Textarea value={settings[meta.key] || meta.defaultBlock} onChange={(e) => updateSetting(meta.key as keyof Settings, e.target.value)} className="min-h-[92px] max-h-[220px] text-xs !field-sizing-fixed resize-y overflow-y-auto font-mono" />
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <Dialog open={versionDialogOpen} onOpenChange={setVersionDialogOpen}>
        <DialogContent className="max-h-[min(680px,calc(100vh-2rem))] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>提示词版本</DialogTitle>
            <DialogDescription>保存 System 与 9 个评判块的命名快照；评分权重和其他设置不随版本切换。</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input
              value={versionName}
              onChange={(event) => setVersionName(event.target.value.slice(0, 40))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void savePromptVersion()
                }
              }}
              placeholder="例如：低噪声评分 v1"
              className="h-8 text-xs"
              maxLength={40}
            />
            <Button type="button" size="sm" className="h-8 gap-1 text-xs" onClick={() => void savePromptVersion()} disabled={versionSaving || !versionName.trim()}>
              <Save className="h-3 w-3" />
              {versionSaving ? '保存中…' : '保存当前'}
            </Button>
          </div>
          <div className="space-y-1 border-t pt-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>已保存版本（最多 {PROMPT_VERSION_LIMIT} 个）</span>
              <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => void loadVersions()} disabled={versionsLoading}>刷新</Button>
            </div>
            {versionsLoading ? (
              <p className="py-5 text-center text-xs text-muted-foreground">读取版本中…</p>
            ) : versions.length === 0 ? (
              <p className="py-5 text-center text-xs text-muted-foreground">暂无版本。调改前先保存当前版本即可随时回退。</p>
            ) : versions.map((version) => (
              <div key={version.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{version.name}</p>
                  <p className="text-[11px] text-muted-foreground">{formatVersionTime(version.createdAt)}</p>
                </div>
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-violet-700 hover:text-violet-800" onClick={() => openPromptComparison(version)}>对比</Button>
                <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setVersionToLoad(version)}>载入</Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => exportPromptVersion(version)} title={`导出「${version.name}」`}>
                  <Download className="h-3 w-3" />
                  导出
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive hover:text-destructive" onClick={() => void removePromptVersion(version.id)}>
                  <Trash2 className="h-3 w-3" />
                  删除
                </Button>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setVersionDialogOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!versionToCompare} onOpenChange={(open) => !open && setVersionToCompare(null)}>
        <DialogContent className="max-h-[min(760px,calc(100vh-2rem))] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>与当前提示词对比</DialogTitle>
            <DialogDescription>
              当前页面与「{versionToCompare?.name}」对比。红色为仅当前存在，绿色为仅该版本存在；相同行不会显示。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-x-3 gap-y-1 border-y py-2 text-xs">
            <span className="text-muted-foreground">相同 {PROMPT_VERSION_KEYS.length - promptComparison.length} 项</span>
            <span className={promptComparison.length === 0 ? 'text-emerald-700' : 'font-medium text-amber-700'}>
              不同 {promptComparison.length} 项
            </span>
          </div>
          {promptComparison.length === 0 ? (
            <p className="py-8 text-center text-sm text-emerald-700">与当前页面完全一致</p>
          ) : (
            <div className="space-y-3">
              {promptComparison.map((field) => (
                <section key={field.key} className="overflow-hidden border">
                  <h3 className="bg-muted/50 px-3 py-2 text-xs font-semibold">{promptVersionLabel(field.key)}</h3>
                  <div className="space-y-1 p-2 text-xs leading-5">
                    {field.lines.map((line, index) => (
                      <div
                        key={`${line.kind}-${index}-${line.value}`}
                        className={`grid grid-cols-[52px_minmax(0,1fr)] gap-2 px-2 py-1 ${line.kind === 'current'
                          ? 'bg-red-50 text-red-800'
                          : 'bg-emerald-50 text-emerald-800'}`}
                      >
                        <span className="font-semibold">{line.kind === 'current' ? '− 当前' : '+ 版本'}</span>
                        <span className="break-words whitespace-pre-wrap">{line.value}</span>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setVersionToCompare(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!versionToLoad} onOpenChange={(open) => !open && setVersionToLoad(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>载入提示词版本？</AlertDialogTitle>
            <AlertDialogDescription>
              将把当前页面的 System 和 9 个评判块替换为「{versionToLoad?.name}」。载入后不会立即生效，需点击底部“保存设置”。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => versionToLoad && loadPromptVersion(versionToLoad)}>确认载入</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
