'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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

import AiModelTab from '@/components/settings/ai-model'
import PromptsTab from '@/components/settings/prompts'
import PushTab from '@/components/settings/push'
import DataTab from '@/components/settings/data'
import AccountTab from '@/components/settings/account'
import KeywordsTab from '@/components/keywords-tab'
import DashboardTab from '@/components/dashboard-tab'
import PushLogTab from '@/components/push-log-tab'
import { SourcesManagement } from '@/components/sources-tab'

export default function SettingsTab() {
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
    // 历史:曾把「等于默认值」的提示词抹成空串,导致导出文件里整片提示词为空、
    // UI 显示默认值而 DB 是空串,UI/DB 长期不一致。
    // 修正:存什么就是什么。UI 在读取时已有 `value || DEFAULT_*` 兜底,
    // 用户清空再保存会存空串(应用场景:用户主动不想用此提示词,运行期 prompts.ts
    // 的 pickBlock 也会回退到 defaultBlock,行为不变)。
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
      await saveSettings(buildSavePayload())
      if (mountedRef.current) {
        settingsBaselineRef.current = currentSettingsFingerprint
        toast.success('设置已保存')
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
    <div className="flex flex-col h-full min-h-0">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* 移动端横向滚动；桌面端自然展示全部 tab */}
        <div className="overflow-x-auto mx-3 mt-3 sm:mx-4 sm:mt-4 shrink-0 [&::-webkit-scrollbar]:hidden">
          <TabsList className="h-9 flex-nowrap">
            <TabsTrigger value="dashboard" className="text-xs px-3 h-7 whitespace-nowrap">概览</TabsTrigger>
            <TabsTrigger value="sources" className="text-xs px-3 h-7 whitespace-nowrap">源管理</TabsTrigger>
            <TabsTrigger value="keywords" className="text-xs px-3 h-7 whitespace-nowrap">关键词</TabsTrigger>
            <TabsTrigger value="ai-model" className="text-xs px-3 h-7 whitespace-nowrap">AI 模型</TabsTrigger>
            <TabsTrigger value="prompts" className="text-xs px-3 h-7 whitespace-nowrap">提示词</TabsTrigger>
            <TabsTrigger value="push" className="text-xs px-3 h-7 whitespace-nowrap">推送</TabsTrigger>
            <TabsTrigger value="push-log" className="text-xs px-3 h-7 whitespace-nowrap">推送记录</TabsTrigger>
            <TabsTrigger value="account" className="text-xs px-3 h-7 whitespace-nowrap">账户</TabsTrigger>
            <TabsTrigger value="data" className="text-xs px-3 h-7 whitespace-nowrap">数据清理</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="dashboard" className="flex-1 m-0 min-h-0 overflow-auto px-3 pb-3 sm:px-4 sm:pb-4">
          <DashboardTab />
        </TabsContent>

        <TabsContent value="data" className="flex-1 m-0 min-h-0 overflow-auto px-3 pb-3 sm:px-4 sm:pb-4">
          <DataTab />
        </TabsContent>

        <TabsContent value="sources" className="flex-1 m-0 min-h-0 overflow-hidden">
          <SourcesManagement />
        </TabsContent>

        <TabsContent value="ai-model" className="flex-1 m-0 min-h-0 overflow-auto px-3 pb-3 sm:px-4 sm:pb-4">
          <AiModelTab
            settings={settings}
            setSettings={setSettings}
            providerConfigs={providerConfigs}
            setProviderConfigs={setProviderConfigs}
          />
        </TabsContent>

        <TabsContent value="prompts" className="flex-1 m-0 min-h-0 overflow-auto px-3 pb-3 sm:px-4 sm:pb-4">
          <PromptsTab settings={settings} setSettings={setSettings} />
        </TabsContent>

        <TabsContent value="push" className="flex-1 m-0 min-h-0 overflow-auto px-3 pb-3 sm:px-4 sm:pb-4">
          <PushTab settings={settings} setSettings={setSettings} />
        </TabsContent>

        <TabsContent value="push-log" className="flex-1 m-0 min-h-0 overflow-auto px-3 pb-3 sm:px-4 sm:pb-4">
          <PushLogTab />
        </TabsContent>

        <TabsContent value="account" className="flex-1 m-0 min-h-0 overflow-auto px-3 pb-3 sm:px-4 sm:pb-4">
          <AccountTab />
        </TabsContent>

        <TabsContent value="keywords" className="flex-1 m-0 min-h-0 overflow-auto px-3 pb-3 sm:px-4 sm:pb-4">
          <KeywordsTab />
        </TabsContent>
      </Tabs>

      {hasUnsavedChanges && (
        <div className="border-t p-3 sm:p-4 bg-background shrink-0 flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
            <Info className="h-3.5 w-3.5" />
            有未保存的设置变更
          </span>
          <Button
            onClick={handleSave}
            disabled={saving}
            className="gap-1.5 w-full sm:w-auto sm:ml-auto"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {saving ? '保存中...' : '保存设置'}
          </Button>
        </div>
      )}
    </div>
  )
}
