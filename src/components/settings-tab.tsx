'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Loader2, Info } from 'lucide-react'
import { toast } from 'sonner'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  FRONTEND_SETTING_KEYS,
  ProviderConfigs,
  Settings as SettingsType,
} from '@/components/settings/types'
import { AI_PROVIDERS, providerSettingKey as providerKey, type AIProviderId } from '@/contracts/ai-provider'
import { getFrontendSettingDefaults, SETTING_KEYS } from '@/lib/settings-catalog'
import { fetchSettings, revealSettings, saveSettings } from '@/features/settings-api.client'

const sectionLoading = () => <Skeleton className="mt-4 h-40 w-full" />
const loadAiModel = () => import('@/components/settings/ai-model')
const loadPrompts = () => import('@/components/settings/prompts')
const loadPush = () => import('@/components/settings/push')
const loadData = () => import('@/components/settings/data')
const loadAccount = () => import('@/components/settings/account')
const loadKeywords = () => import('@/components/keywords-tab')
const loadDashboard = () => import('@/components/dashboard-tab')
const loadSources = () => import('@/components/sources-tab')
const loadPublic = () => import('@/components/settings/public')
const AiModelTab = dynamic(loadAiModel, { loading: sectionLoading })
const PromptsTab = dynamic(loadPrompts, { loading: sectionLoading })
const PushTab = dynamic(loadPush, { loading: sectionLoading })
const DataTab = dynamic(loadData, { loading: sectionLoading })
const AccountTab = dynamic(loadAccount, { loading: sectionLoading })
const KeywordsTab = dynamic(loadKeywords, { loading: sectionLoading })
const DashboardTab = dynamic(loadDashboard, { loading: sectionLoading })
const SourcesManagement = dynamic(
  () => loadSources().then((module) => module.SourcesManagement),
  { loading: sectionLoading },
)
const PublicTab = dynamic(loadPublic, { loading: sectionLoading })

const sectionLoaders: Record<string, () => Promise<unknown>> = {
  dashboard: loadDashboard,
  public: loadPublic,
  sources: loadSources,
  keywords: loadKeywords,
  'ai-model': loadAiModel,
  prompts: loadPrompts,
  push: loadPush,
  account: loadAccount,
  data: loadData,
}

export default function SettingsTab({ active = true }: { active?: boolean }) {
  const [settings, setSettings] = useState<SettingsType>(() => (
    getFrontendSettingDefaults() as unknown as SettingsType
  ))

  const [providerConfigs, setProviderConfigs] = useState<ProviderConfigs>(() => {
    const configs: ProviderConfigs = {} as ProviderConfigs
    for (const id of Object.keys(AI_PROVIDERS) as AIProviderId[]) {
      const def = AI_PROVIDERS[id]
      configs[id] = { apiKey: '', baseUrl: def.baseUrl, model: def.defaultModel }
    }
    return configs
  })

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState('dashboard')
  const settingsBaselineRef = useRef<string | null>(null)
  const revealAttemptedRef = useRef(false)
  const pendingRevealBaselineRef = useRef<string | null>(null)
  // reveal 401 只提示一次：避免 StrictMode 双跑 / 刷新 / 切回设置页重复打扰；
  // 用户在「账户」填好 token 后下一次 fetchSettings 会自动恢复明文回显。
  const warnedAuthRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const settingsFingerprint = useCallback((nextSettings: SettingsType, nextProviders: ProviderConfigs) => (
    JSON.stringify({ settings: nextSettings, providers: nextProviders })
  ), [])
  const currentSettingsFingerprint = settingsFingerprint(settings, providerConfigs)
  const hasUnsavedChanges = settingsBaselineRef.current !== null
    && currentSettingsFingerprint !== settingsBaselineRef.current

  const loadSettingsTab = useCallback(async () => {
    try {
      const data = await fetchSettings()

      // 1. 基础设置(非敏感 key)
      const newSettings: Partial<SettingsType> = {}
      for (const k of FRONTEND_SETTING_KEYS) {
        if (data[k] !== undefined) newSettings[k] = String(data[k])
      }
      setSettings(prev => ({ ...prev, ...newSettings }))

      // 2. provider 专属配置
      const baseConfigs: ProviderConfigs = {} as ProviderConfigs
      for (const id of Object.keys(AI_PROVIDERS) as AIProviderId[]) {
        const def = AI_PROVIDERS[id]
        baseConfigs[id] = {
          apiKey: data[providerKey(id, 'api_key')] || '',
          baseUrl: data[providerKey(id, 'base_url')] || def.baseUrl,
          model: data[providerKey(id, 'model')] || def.defaultModel,
        }
      }
      setProviderConfigs(baseConfigs)

    } catch {
      toast.error('获取设置失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const revealSensitiveSettingsForEditor = useCallback(async () => {
    try {
      const revealKeys = activeTab === 'push'
        ? [SETTING_KEYS.FEISHU_WEBHOOK_URL]
        : (Object.keys(AI_PROVIDERS) as AIProviderId[]).map((id) => providerKey(id, 'api_key'))
      const revealed = await revealSettings(revealKeys)
      const nextSettings = {
        ...settings,
        ...(typeof revealed.feishu_webhook_url === 'string'
          ? { feishu_webhook_url: revealed.feishu_webhook_url }
          : {}),
      }
      const nextProviders = Object.fromEntries(
        (Object.keys(AI_PROVIDERS) as AIProviderId[]).map((id) => {
          const cfg = providerConfigs[id]
          const value = revealed[providerKey(id, 'api_key')]
          return [id, { ...cfg, apiKey: typeof value === 'string' ? value : cfg.apiKey }]
        }),
      ) as ProviderConfigs
      pendingRevealBaselineRef.current = settingsFingerprint(nextSettings, nextProviders)
      setSettings(nextSettings)
      setProviderConfigs(nextProviders)
    } catch (err) {
      revealAttemptedRef.current = false
      if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) {
        if (!warnedAuthRef.current) {
          warnedAuthRef.current = true
          toast.warning('未授权访问密钥,请在「账户」标签页填写 API Token', {
            description: '留空输入框保存 = 保持原值不变',
          })
        }
      }
    }
  }, [activeTab, providerConfigs, settings, settingsFingerprint])

  useEffect(() => {
    const handle = setTimeout(loadSettingsTab, 0)
    return () => clearTimeout(handle)
  }, [loadSettingsTab])

  useEffect(() => {
    if (!loading) {
      settingsBaselineRef.current = currentSettingsFingerprint
    }
    // 仅在初次加载结束时建立基线；后续编辑不能覆盖基线。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

  useEffect(() => {
    if (loading || !['ai-model', 'push'].includes(activeTab) || revealAttemptedRef.current) return
    revealAttemptedRef.current = true
    void revealSensitiveSettingsForEditor()
  }, [activeTab, loading, revealSensitiveSettingsForEditor])

  useEffect(() => {
    const pending = pendingRevealBaselineRef.current
    if (pending && pending === currentSettingsFingerprint) {
      settingsBaselineRef.current = pending
      pendingRevealBaselineRef.current = null
    }
  }, [currentSettingsFingerprint])

  const buildSavePayload = useCallback((): Record<string, string> => {
    const payload: Record<string, string> = { ...settings }
    // 前端按当前显示值完整保存；提示词空白值由服务端统一归一化为当前默认文本。
    for (const id of Object.keys(AI_PROVIDERS) as AIProviderId[]) {
      const config = providerConfigs[id]
      if (!config) continue
      payload[providerKey(id, 'api_key')] = config.apiKey
      payload[providerKey(id, 'base_url')] = config.baseUrl
      payload[providerKey(id, 'model')] = config.model
    }
    return payload
  }, [settings, providerConfigs])

  const handleSave = async () => {
    setSaving(true)
    try {
      const result = await saveSettings(buildSavePayload()) as { scoreRecomputed?: number; publicationRebuilt?: boolean }
      if (mountedRef.current) {
        settingsBaselineRef.current = currentSettingsFingerprint
        const details = [
          result.scoreRecomputed ? `已重算 ${result.scoreRecomputed} 篇评分` : '',
          result.publicationRebuilt ? '已同步公开状态' : '',
        ].filter(Boolean).join('，')
        toast.success(details ? `设置已保存，${details}` : '设置已保存')
      }
    } catch (err) {
      if (mountedRef.current) {
        // requestJson 抛出 RequestJsonError 时把 body 透传到 error.data；其它情况 instanceof Error 时给 message。
        const message =
          err && typeof err === 'object' && 'body' in err
            ? (() => {
                const body = (err as { body?: unknown }).body;
                if (body && typeof body === 'object') {
                  const b = body as { details?: unknown; error?: unknown };
                  if (Array.isArray(b.details) && b.details.length > 0) return b.details.join('; ');
                  if (typeof b.error === 'string') return b.error;
                }
                return '保存失败';
              })()
            : err instanceof Error
              ? err.message
              : '保存失败';
        toast.error(message);
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false)
      }
    }
  }

  if (loading) {
    return (
      <div className="p-4 space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    )
  }

  return (
    // 关键:min-h-0 让 flex 子项可以收缩到 0,否则 Tabs 会被超长内容
    // (如提示词的 9 个 Textarea = 1600+px)撑爆,把底部保存按钮挤出视口。
    <div className="settings-surface flex h-full min-h-0 flex-col text-sm">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col overflow-hidden [&_[data-slot=button]]:rounded-none [&_[data-slot=button]]:shadow-none [&_[data-slot=input]]:rounded-none [&_[data-slot=input]]:shadow-none [&_[data-slot=textarea]]:rounded-none [&_[data-slot=textarea]]:shadow-none [&_[data-slot=select-trigger]]:rounded-none [&_[data-slot=select-trigger]]:shadow-none [&_[data-slot=badge]]:rounded-none [&_[data-slot=card]]:rounded-none [&_[data-slot=card]]:shadow-none">
        {/* 移动端横向滚动；桌面端自然展示全部 tab */}
        <div className="shrink-0 overflow-x-auto border-b bg-background px-2 pt-1 [&::-webkit-scrollbar]:hidden">
          <TabsList
            className="h-8 flex-nowrap rounded-none bg-transparent p-0"
            onMouseOver={(event) => {
              const value = (event.target as HTMLElement).closest<HTMLElement>('[data-value]')?.dataset.value
              if (value) void sectionLoaders[value]?.()
            }}
            onFocusCapture={(event) => {
              const value = (event.target as HTMLElement).closest<HTMLElement>('[data-value]')?.dataset.value
              if (value) void sectionLoaders[value]?.()
            }}
          >
            <TabsTrigger value="dashboard" data-value="dashboard" className="h-7 rounded-none border-0 border-b-2 px-3 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none">概览</TabsTrigger>
            <TabsTrigger value="public" data-value="public" className="h-7 rounded-none border-0 border-b-2 px-3 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none">公开</TabsTrigger>
            <TabsTrigger value="sources" data-value="sources" className="h-7 rounded-none border-0 border-b-2 px-3 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none">源管理</TabsTrigger>
            <TabsTrigger value="keywords" data-value="keywords" className="h-7 rounded-none border-0 border-b-2 px-3 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none">关键词</TabsTrigger>
            <TabsTrigger value="ai-model" data-value="ai-model" className="h-7 rounded-none border-0 border-b-2 px-3 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none">AI 模型</TabsTrigger>
            <TabsTrigger value="prompts" data-value="prompts" className="h-7 rounded-none border-0 border-b-2 px-3 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none">提示词</TabsTrigger>
            <TabsTrigger value="push" data-value="push" className="h-7 rounded-none border-0 border-b-2 px-3 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none">推送</TabsTrigger>
            <TabsTrigger value="account" data-value="account" className="h-7 rounded-none border-0 border-b-2 px-3 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none">账户</TabsTrigger>
            <TabsTrigger value="data" data-value="data" className="h-7 rounded-none border-0 border-b-2 px-3 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none">数据清理</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="dashboard" className="flex-1 m-0 min-h-0 overflow-auto px-2 pb-2">
          <DashboardTab active={active && activeTab === 'dashboard'} />
        </TabsContent>

        <TabsContent value="public" className="m-0 min-h-0 flex-1 overflow-auto px-2 pb-2">
          <PublicTab settings={settings} setSettings={setSettings} />
        </TabsContent>

        <TabsContent value="data" className="m-0 min-h-0 flex-1 overflow-auto px-2 pb-2">
          <DataTab />
        </TabsContent>

        <TabsContent value="sources" className="flex-1 m-0 min-h-0 overflow-hidden">
          <SourcesManagement />
        </TabsContent>

        <TabsContent value="ai-model" className="m-0 min-h-0 flex-1 overflow-auto px-2 pb-2">
          <AiModelTab
            settings={settings}
            setSettings={setSettings}
            providerConfigs={providerConfigs}
            setProviderConfigs={setProviderConfigs}
          />
        </TabsContent>

        <TabsContent value="prompts" className="m-0 min-h-0 flex-1 overflow-auto px-2 pb-2">
          <PromptsTab settings={settings} setSettings={setSettings} />
        </TabsContent>

        <TabsContent value="push" className="m-0 min-h-0 flex-1 overflow-auto px-2 pb-2">
          <PushTab settings={settings} setSettings={setSettings} />
        </TabsContent>

        <TabsContent value="account" className="m-0 min-h-0 flex-1 overflow-auto px-2 pb-2">
          <AccountTab />
        </TabsContent>

        <TabsContent value="keywords" className="m-0 min-h-0 flex-1 overflow-auto">
          <KeywordsTab />
        </TabsContent>
      </Tabs>

      {hasUnsavedChanges && (
        <div className="flex shrink-0 items-center gap-2 border-t bg-background px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
            <Info className="h-3.5 w-3.5" />
            有未保存的设置变更
          </span>
          <Button
            onClick={handleSave}
            disabled={saving}
            className="ml-auto h-7 gap-1.5 px-3 text-xs"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {saving ? '保存中...' : '保存设置'}
          </Button>
        </div>
      )}
    </div>
  )
}
