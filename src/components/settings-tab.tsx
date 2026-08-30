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
import { fetchSettings, revealSettings, saveSettings, subscribeToSettingsChanged } from '@/features/settings-api.client'

const sectionLoading = () => <Skeleton className="mt-4 h-40 w-full" />
const loadAiModel = () => import('@/components/settings/ai-model')
const loadPrompts = () => import('@/components/settings/prompts')
const loadPush = () => import('@/components/settings/push')
const loadData = () => import('@/components/settings/data')
const loadBackup = () => import('@/components/settings/backup')
const loadAccount = () => import('@/components/settings/account')
const loadKeywords = () => import('@/components/keywords-tab')
const loadDashboard = () => import('@/components/dashboard-tab')
const loadSources = () => import('@/components/sources-tab')
const loadPublic = () => import('@/components/settings/public')
const loadToolDirectory = () => import('@/components/settings/tool-directory')
const loadProxy = () => import('@/components/settings/proxy')
const AiModelTab = dynamic(loadAiModel, { loading: sectionLoading })
const PromptsTab = dynamic(loadPrompts, { loading: sectionLoading })
const PushTab = dynamic(loadPush, { loading: sectionLoading })
const DataTab = dynamic(loadData, { loading: sectionLoading })
const BackupTab = dynamic(loadBackup, { loading: sectionLoading })
const AccountTab = dynamic(loadAccount, { loading: sectionLoading })
const KeywordsTab = dynamic(loadKeywords, { loading: sectionLoading })
const DashboardTab = dynamic(loadDashboard, { loading: sectionLoading })
const SourcesManagement = dynamic(
  () => loadSources().then((module) => module.SourcesManagement),
  { loading: sectionLoading },
)
const PublicTab = dynamic(loadPublic, { loading: sectionLoading })
const ToolDirectoryManagement = dynamic(loadToolDirectory, { loading: sectionLoading })
const ProxyTab = dynamic(loadProxy, { loading: sectionLoading })

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
  backup: loadBackup,
  tools: loadToolDirectory,
  proxy: loadProxy,
}

type SensitiveTab = 'ai-model' | 'push' | 'proxy'
type SensitiveRevealState = Record<SensitiveTab, 'idle' | 'loading' | 'ready' | 'error'>

function buildSettingsSavePayload(
  settings: SettingsType,
  providerConfigs: ProviderConfigs,
  sensitiveReady: Record<SensitiveTab, boolean>,
): Record<string, string> {
  const payload: Record<string, string> = { ...settings }
  // GET /api/settings 只返回脱敏占位值。未完成 reveal 时禁止提交敏感字段，
  // 避免一次普通设置保存把服务端仍然存在的密钥/Webhook 覆盖掉。
  if (!sensitiveReady.push) delete payload[SETTING_KEYS.FEISHU_WEBHOOK_URL]
  if (!sensitiveReady.proxy) delete payload[SETTING_KEYS.OUTBOUND_PROXY_URL]
  // 前端按当前显示值完整保存；提示词空白值由服务端统一归一化为当前默认文本。
  for (const id of Object.keys(AI_PROVIDERS) as AIProviderId[]) {
    const config = providerConfigs[id]
    if (!config) continue
    if (sensitiveReady['ai-model']) payload[providerKey(id, 'api_key')] = config.apiKey
    payload[providerKey(id, 'base_url')] = config.baseUrl
    payload[providerKey(id, 'model')] = config.model
  }
  return payload
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
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState('dashboard')
  const settingsBaselineRef = useRef<string | null>(null)
  const settingsBaselineStateRef = useRef<SettingsType | null>(null)
  const providerBaselineRef = useRef<ProviderConfigs | null>(null)
  const revealedSensitiveTabsRef = useRef<Set<SensitiveTab>>(new Set())
  const pendingRevealBaselineRef = useRef<string | null>(null)
  // reveal 401 只提示一次：避免 StrictMode 双跑 / 刷新 / 切回设置页重复打扰。
  const warnedAuthRef = useRef(false)
  const mountedRef = useRef(true)
  const latestSettingsRef = useRef(settings)
  const latestProviderConfigsRef = useRef(providerConfigs)
  const [sensitiveRevealState, setSensitiveRevealState] = useState<SensitiveRevealState>({
    'ai-model': 'idle',
    push: 'idle',
    proxy: 'idle',
  })

  // 异步保存期间用户仍可能继续编辑；保存完成时必须以最新状态判断是否还有未保存内容。
  latestSettingsRef.current = settings
  latestProviderConfigsRef.current = providerConfigs

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

  useEffect(() => {
    if (!hasUnsavedChanges) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedChanges])

  const loadSettingsTab = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const data = await fetchSettings()
      const requiredKeys = [
        ...FRONTEND_SETTING_KEYS,
        ...(Object.keys(AI_PROVIDERS) as AIProviderId[]).flatMap((id) => [
          providerKey(id, 'api_key'),
          providerKey(id, 'base_url'),
          providerKey(id, 'model'),
        ]),
      ]
      if (requiredKeys.some((key) => typeof data[key] !== 'string')) {
        throw new Error('设置响应不完整')
      }

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
      setSensitiveRevealState({ 'ai-model': 'idle', push: 'idle', proxy: 'idle' })

    } catch {
      setLoadError(true)
      toast.error('获取设置失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const revealSensitiveSettingsForEditor = useCallback(async (tab: SensitiveTab) => {
    const capturedSettings = settings
    const capturedProviders = providerConfigs
    setSensitiveRevealState((current) => ({ ...current, [tab]: 'loading' }))
    try {
      const revealKeys = tab === 'push'
        ? [SETTING_KEYS.FEISHU_WEBHOOK_URL]
        : tab === 'proxy'
          ? [SETTING_KEYS.OUTBOUND_PROXY_URL]
          : (Object.keys(AI_PROVIDERS) as AIProviderId[]).map((id) => providerKey(id, 'api_key'))
      const revealed = await revealSettings(revealKeys)
      if (revealKeys.some((key) => typeof revealed[key] !== 'string')) {
        throw new Error('敏感配置响应不完整')
      }
      const revealedWebhook = typeof revealed.feishu_webhook_url === 'string'
        ? revealed.feishu_webhook_url
        : undefined
      const revealedProxy = typeof revealed[SETTING_KEYS.OUTBOUND_PROXY_URL] === 'string'
        ? revealed[SETTING_KEYS.OUTBOUND_PROXY_URL]
        : undefined
      const nextSettings = {
        ...capturedSettings,
        ...(revealedWebhook === undefined ? {} : { feishu_webhook_url: revealedWebhook }),
        ...(revealedProxy === undefined ? {} : { outbound_proxy_url: revealedProxy }),
      }
      const nextProviders = Object.fromEntries(
        (Object.keys(AI_PROVIDERS) as AIProviderId[]).map((id) => {
          const cfg = capturedProviders[id]
          const value = revealed[providerKey(id, 'api_key')]
          return [id, { ...cfg, apiKey: typeof value === 'string' ? value : cfg.apiKey }]
        }),
      ) as ProviderConfigs
      pendingRevealBaselineRef.current = settingsFingerprint(nextSettings, nextProviders)
      // 回显请求可能晚于用户输入完成；只回填请求开始时仍未被修改的字段。
      setSettings((current) => (
        {
          ...current,
          ...(revealedWebhook !== undefined && current.feishu_webhook_url === capturedSettings.feishu_webhook_url
            ? { feishu_webhook_url: revealedWebhook }
            : {}),
          ...(revealedProxy !== undefined && current.outbound_proxy_url === capturedSettings.outbound_proxy_url
            ? { outbound_proxy_url: revealedProxy }
            : {}),
        }
      ))
      setProviderConfigs((current) => {
        const next = { ...current }
        for (const id of Object.keys(AI_PROVIDERS) as AIProviderId[]) {
          const currentConfig = current[id]
          const capturedConfig = capturedProviders[id]
          const value = revealed[providerKey(id, 'api_key')]
          if (
            typeof value === 'string'
            && currentConfig.apiKey === capturedConfig.apiKey
          ) {
            next[id] = { ...currentConfig, apiKey: value }
          }
        }
        return next
      })
      setSensitiveRevealState((current) => ({ ...current, [tab]: 'ready' }))
    } catch (err) {
      // 同一类敏感配置加载失败时允许下一次进入该页重试；另一类配置互不影响。
      revealedSensitiveTabsRef.current.delete(tab)
      setSensitiveRevealState((current) => ({ ...current, [tab]: 'error' }))
      if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) {
        if (!warnedAuthRef.current) {
          warnedAuthRef.current = true
          toast.warning('当前会话无权读取敏感配置，请重新登录后重试', {
            description: '为保护已有密钥，敏感配置已锁定，普通设置仍可保存。',
          })
        }
      }
    }
  }, [providerConfigs, settings, settingsFingerprint])

  useEffect(() => {
    const handle = setTimeout(loadSettingsTab, 0)
    return () => clearTimeout(handle)
  }, [loadSettingsTab])

  useEffect(() => {
    if (!loading && !loadError) {
      settingsBaselineRef.current = currentSettingsFingerprint
      settingsBaselineStateRef.current = settings
      providerBaselineRef.current = providerConfigs
    }
    // 仅在初次加载结束时建立基线；后续编辑不能覆盖基线。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, loadError])

  useEffect(() => subscribeToSettingsChanged((changes) => {
    setSettings(prev => ({ ...prev, ...changes }))

    const baselineSettings = settingsBaselineStateRef.current
    if (!baselineSettings) return
    const nextBaselineSettings = { ...baselineSettings, ...changes } as SettingsType
    const baselineProviders = providerBaselineRef.current ?? providerConfigs
    settingsBaselineStateRef.current = nextBaselineSettings
    settingsBaselineRef.current = settingsFingerprint(nextBaselineSettings, baselineProviders)
  }), [providerConfigs, settingsFingerprint])

  useEffect(() => {
    const tab = activeTab === 'ai-model' || activeTab === 'push' || activeTab === 'proxy' ? activeTab : null
    if (loading || loadError || !tab || revealedSensitiveTabsRef.current.has(tab)) return
    revealedSensitiveTabsRef.current.add(tab)
    void revealSensitiveSettingsForEditor(tab)
  }, [activeTab, loading, loadError, revealSensitiveSettingsForEditor])

  const retrySensitiveSettings = useCallback((tab: SensitiveTab) => {
    revealedSensitiveTabsRef.current.delete(tab)
    revealedSensitiveTabsRef.current.add(tab)
    void revealSensitiveSettingsForEditor(tab)
  }, [revealSensitiveSettingsForEditor])

  useEffect(() => {
    const pending = pendingRevealBaselineRef.current
    if (pending && pending === currentSettingsFingerprint) {
      settingsBaselineRef.current = pending
      settingsBaselineStateRef.current = settings
      providerBaselineRef.current = providerConfigs
      pendingRevealBaselineRef.current = null
    }
  }, [currentSettingsFingerprint, providerConfigs, settings])

  const handleSave = async () => {
    const submittedSettings = latestSettingsRef.current
    const submittedProviderConfigs = latestProviderConfigsRef.current
    const sensitiveReady = {
      'ai-model': sensitiveRevealState['ai-model'] === 'ready',
      push: sensitiveRevealState.push === 'ready',
      proxy: sensitiveRevealState.proxy === 'ready',
    }
    const payload = buildSettingsSavePayload(submittedSettings, submittedProviderConfigs, sensitiveReady)
    const priorSettings = settingsBaselineStateRef.current
    const priorProviders = providerBaselineRef.current
    const persistedBaselineSettings = { ...submittedSettings }
    const persistedBaselineProviders = { ...submittedProviderConfigs }
    const pushSensitiveDirty = !sensitiveReady.push
      && Boolean(priorSettings)
      && submittedSettings.feishu_webhook_url !== priorSettings?.feishu_webhook_url
    const proxySensitiveDirty = !sensitiveReady.proxy
      && Boolean(priorSettings)
      && submittedSettings.outbound_proxy_url !== priorSettings?.outbound_proxy_url
    const aiSensitiveDirty = !sensitiveReady['ai-model']
      && Boolean(priorProviders)
      && (Object.keys(AI_PROVIDERS) as AIProviderId[]).some((id) => (
        submittedProviderConfigs[id]?.apiKey !== priorProviders?.[id]?.apiKey
      ))
    if (!sensitiveReady.push && priorSettings) {
      persistedBaselineSettings.feishu_webhook_url = priorSettings.feishu_webhook_url
    }
    if (!sensitiveReady.proxy && priorSettings) {
      persistedBaselineSettings.outbound_proxy_url = priorSettings.outbound_proxy_url
    }
    if (!sensitiveReady['ai-model'] && priorProviders) {
      for (const id of Object.keys(AI_PROVIDERS) as AIProviderId[]) {
        persistedBaselineProviders[id] = {
          ...persistedBaselineProviders[id],
          apiKey: priorProviders[id]?.apiKey ?? persistedBaselineProviders[id]?.apiKey ?? '',
        }
      }
    }
    const persistedFingerprint = settingsFingerprint(persistedBaselineSettings, persistedBaselineProviders)
    setSaving(true)
    try {
      const result = await saveSettings(payload) as { rebuildQueued?: boolean; rebuildJobQueued?: boolean }
      if (mountedRef.current) {
        // 基线对应本次真正提交的快照；若请求期间继续编辑，后续改动仍会保持“未保存”。
        settingsBaselineRef.current = persistedFingerprint
        settingsBaselineStateRef.current = persistedBaselineSettings
        providerBaselineRef.current = persistedBaselineProviders
        const details = [
          result.rebuildQueued
            ? result.rebuildJobQueued
              ? '后台正在同步评分和公开状态'
              : '评分和公开状态将在当前任务结束后自动同步'
            : '',
          aiSensitiveDirty ? 'AI 密钥未保存（尚未完成安全读取）' : '',
          pushSensitiveDirty ? 'Webhook 未保存（尚未完成安全读取）' : '',
          proxySensitiveDirty ? '代理未保存（尚未完成安全读取）' : '',
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

  if (loadError) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-medium">设置读取失败</p>
        <p className="text-xs text-muted-foreground">为避免用默认值覆盖服务器配置，当前未开放编辑和保存。</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void loadSettingsTab()}>重新读取</Button>
      </div>
    )
  }

  return (
    // 关键:min-h-0 让 flex 子项可以收缩到 0,否则 Tabs 会被超长内容
    // (如提示词的 9 个 Textarea = 1600+px)撑爆,把底部保存按钮挤出视口。
    <div className="settings-surface flex h-full min-h-0 flex-col text-sm">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/20 [&_[data-slot=button]]:rounded-none [&_[data-slot=button]]:shadow-none [&_[data-slot=input]]:rounded-none [&_[data-slot=input]]:shadow-none [&_[data-slot=textarea]]:rounded-none [&_[data-slot=textarea]]:shadow-none [&_[data-slot=select-trigger]]:rounded-none [&_[data-slot=select-trigger]]:shadow-none [&_[data-slot=badge]]:rounded-none [&_[data-slot=card]]:rounded-none [&_[data-slot=card]]:bg-background [&_[data-slot=card]]:shadow-none">
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
            <TabsTrigger value="proxy" data-value="proxy" className="h-7 rounded-none border-0 border-b-2 px-3 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none">代理</TabsTrigger>
            <TabsTrigger value="account" data-value="account" className="h-7 rounded-none border-0 border-b-2 px-3 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none">账户</TabsTrigger>
            <TabsTrigger value="data" data-value="data" className="h-7 rounded-none border-0 border-b-2 px-3 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none">维护</TabsTrigger>
            <TabsTrigger value="backup" data-value="backup" className="h-7 rounded-none border-0 border-b-2 px-3 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none">备份</TabsTrigger>
            <TabsTrigger value="tools" data-value="tools" className="h-7 rounded-none border-0 border-b-2 px-3 text-xs shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none">工具中心</TabsTrigger>
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

        <TabsContent value="backup" className="m-0 min-h-0 flex-1 overflow-auto px-2 pb-2">
          <BackupTab />
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
            sensitiveStatus={sensitiveRevealState['ai-model']}
            onRetrySensitive={() => retrySensitiveSettings('ai-model')}
          />
        </TabsContent>

        <TabsContent value="prompts" className="m-0 min-h-0 flex-1 overflow-auto px-2 pb-2">
          <PromptsTab settings={settings} setSettings={setSettings} />
        </TabsContent>

        <TabsContent value="push" className="m-0 min-h-0 flex-1 overflow-auto px-2 pb-2">
          <PushTab
            settings={settings}
            setSettings={setSettings}
            sensitiveStatus={sensitiveRevealState.push}
            onRetrySensitive={() => retrySensitiveSettings('push')}
          />
        </TabsContent>

        <TabsContent value="proxy" className="m-0 min-h-0 flex-1 overflow-auto px-2 pb-2">
          <ProxyTab
            settings={settings}
            setSettings={setSettings}
            sensitiveStatus={sensitiveRevealState.proxy}
            onRetrySensitive={() => retrySensitiveSettings('proxy')}
          />
        </TabsContent>

        <TabsContent value="account" className="m-0 min-h-0 flex-1 overflow-auto px-2 pb-2">
          <AccountTab />
        </TabsContent>

        <TabsContent value="keywords" className="m-0 min-h-0 flex-1 overflow-auto">
          <KeywordsTab />
        </TabsContent>

        <TabsContent value="tools" className="m-0 min-h-0 flex-1 overflow-auto">
          <ToolDirectoryManagement />
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
