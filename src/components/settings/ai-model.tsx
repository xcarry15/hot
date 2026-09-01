'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Loader2,
  Bot,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  Cpu,
  RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'
import { fetchOpenCodeModels, fetchOpenRouterModels, testAiSettings, testSavedAiModel, type AiTestResult } from '@/features/settings-api.client'
import { isRequestJsonError } from '@/lib/request-json.client'
import {
  ProviderConfig,
  ProviderConfigs,
  Settings,
} from './types'
import { AI_PROVIDERS, type AIProviderId } from '@/contracts/ai-provider'

interface Props {
  settings: Settings
  setSettings: React.Dispatch<React.SetStateAction<Settings>>
  providerConfigs: ProviderConfigs
  setProviderConfigs: React.Dispatch<React.SetStateAction<ProviderConfigs>>
  sensitiveStatus: 'idle' | 'loading' | 'ready' | 'error'
  onRetrySensitive: () => void
}

const OPENCODE_MODELS_STORAGE_KEY = 'hot2:opencode-free-models:v1'
const OPENROUTER_MODELS_STORAGE_KEY = 'hot2:openrouter-free-models:v1'
const MAX_CACHED_MODELS = 50

function normalizeModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((model): model is string => typeof model === 'string')
    .map(model => model.trim())
    .filter(Boolean))].slice(0, MAX_CACHED_MODELS)
}

function readCachedOpencodeModels(): string[] {
  try {
    const value = window.localStorage.getItem(OPENCODE_MODELS_STORAGE_KEY)
    return normalizeModelIds(value ? JSON.parse(value) : null)
  } catch {
    return []
  }
}

function cacheOpencodeModels(models: string[]): void {
  try {
    window.localStorage.setItem(OPENCODE_MODELS_STORAGE_KEY, JSON.stringify(normalizeModelIds(models)))
  } catch {
    // localStorage 不可用时仍保留当前页面内的模型列表。
  }
}

function readCachedOpenRouterModels(): string[] {
  try {
    const value = window.localStorage.getItem(OPENROUTER_MODELS_STORAGE_KEY)
    return normalizeModelIds(value ? JSON.parse(value) : null)
  } catch {
    return []
  }
}

function cacheOpenRouterModels(models: string[]): void {
  try {
    window.localStorage.setItem(OPENROUTER_MODELS_STORAGE_KEY, JSON.stringify(normalizeModelIds(models)))
  } catch {
    // localStorage 不可用时仍保留当前页面内的模型列表。
  }
}

type FreeAIProviderId = 'openrouter' | 'opencode'

const SLOW_MODEL_LATENCY_MS = 8_000

function getModelHealthKey(provider: FreeAIProviderId, model: string): string {
  return `${provider}:${model}`
}

function getModelHealthStatus(result: AiTestResult | undefined, testing: boolean): { label: string; className: string } {
  if (testing) return { label: '测试中', className: 'text-amber-600' }
  if (!result) return { label: '未测试', className: 'text-muted-foreground' }
  if (result.success) {
    if (result.latencyMs !== undefined && result.latencyMs >= SLOW_MODEL_LATENCY_MS) {
      return { label: '较慢', className: 'text-amber-600' }
    }
    return { label: '可用', className: 'text-emerald-600' }
  }
  return { label: '不可用', className: 'text-destructive' }
}

function getModelChipClass(result: AiTestResult | undefined, selected: boolean, testing: boolean): string {
  const baseClass = 'border px-2 py-0.5 text-[11px] transition-colors'
  const selectedClass = selected ? 'ring-2 ring-primary/40' : ''
  if (testing) return `${baseClass} border-amber-300 bg-amber-50 text-amber-700 animate-pulse ${selectedClass}`
  if (!result) {
    return `${baseClass} ${selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted'}`
  }
  if (!result.success) return `${baseClass} border-red-300 bg-red-50 text-red-700 hover:bg-red-100 ${selectedClass}`
  if (result.latencyMs !== undefined && result.latencyMs >= SLOW_MODEL_LATENCY_MS) {
    return `${baseClass} border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 ${selectedClass}`
  }
  return `${baseClass} border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 ${selectedClass}`
}

function isSharedHealthFailure(result: AiTestResult): boolean {
  return result.errorKind === 'configuration'
    || result.errorKind === 'network'
    || (result.retryAfterMs ?? 0) > 0
}

export default function AiModelTab({ settings, setSettings, providerConfigs, setProviderConfigs, sensitiveStatus, onRetrySensitive }: Props) {
  const [testingAI, setTestingAI] = useState(false)
  const [aiTestResult, setAiTestResult] = useState<AiTestResult | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)
  const [opencodeModels, setOpencodeModels] = useState<string[]>(() => [...AI_PROVIDERS.opencode.models])
  const [loadingOpenCodeModels, setLoadingOpenCodeModels] = useState(false)
  const [openrouterModels, setOpenrouterModels] = useState<string[]>(() => [...AI_PROVIDERS.openrouter.models])
  const [loadingOpenRouterModels, setLoadingOpenRouterModels] = useState(false)
  const [modelTestResults, setModelTestResults] = useState<Record<string, AiTestResult>>({})
  const [testingModels, setTestingModels] = useState<Record<string, boolean>>({})
  const [testingAllModels, setTestingAllModels] = useState(false)
  const [testingProgress, setTestingProgress] = useState({ completed: 0, total: 0 })

  const currentProvider = AI_PROVIDERS[settings.ai_provider as AIProviderId] || AI_PROVIDERS.opencode
  const currentConfig = providerConfigs[currentProvider.id]
  const currentHealthProvider: FreeAIProviderId | null = currentProvider.id === 'opencode' || currentProvider.id === 'openrouter'
    ? currentProvider.id
    : null
  const discoveredModelCandidates = currentProvider.id === 'opencode'
    ? opencodeModels
    : currentProvider.id === 'openrouter'
      ? openrouterModels
      : currentProvider.models
  const currentModelCandidates = [...new Set([
    ...(currentConfig.model.trim() ? [currentConfig.model.trim()] : []),
    ...discoveredModelCandidates,
  ])]

  const loadOpenCodeModels = useCallback(async (showToast: boolean) => {
    setLoadingOpenCodeModels(true)
    try {
      const result = await fetchOpenCodeModels()
      if (result.models.length === 0) {
        if (showToast) toast.info('OpenCode 暂无可用的免费模型')
        return
      }
      const models = normalizeModelIds(result.models)
      setOpencodeModels(models)
      cacheOpencodeModels(models)
      if (showToast) toast.success(`已更新 ${models.length} 个免费模型`)
    } catch {
      if (showToast) toast.error('读取 OpenCode 免费模型失败，已保留当前推荐项')
    } finally {
      setLoadingOpenCodeModels(false)
    }
  }, [])

  const loadOpenRouterModels = useCallback(async (showToast: boolean) => {
    setLoadingOpenRouterModels(true)
    try {
      const result = await fetchOpenRouterModels()
      if (result.models.length === 0) {
        if (showToast) toast.info('OpenRouter 暂无可用的免费模型')
        return
      }
      const models = normalizeModelIds(result.models)
      setOpenrouterModels(models)
      cacheOpenRouterModels(models)
      if (showToast) toast.success(`已更新 ${models.length} 个 OpenRouter 免费模型`)
    } catch {
      if (showToast) toast.error('读取 OpenRouter 免费模型失败，已保留当前推荐项')
    } finally {
      setLoadingOpenRouterModels(false)
    }
  }, [])

  useEffect(() => {
    if (currentProvider.id !== 'opencode') return
    const cachedModels = readCachedOpencodeModels()
    if (cachedModels.length > 0) setOpencodeModels(cachedModels)
    // 切换到 OpenCode 时同步一次列表；接口失败时保留上次成功结果。
    void loadOpenCodeModels(false)
  }, [currentProvider.id, loadOpenCodeModels])

  useEffect(() => {
    if (currentProvider.id !== 'openrouter') return
    const cachedModels = readCachedOpenRouterModels()
    if (cachedModels.length > 0) setOpenrouterModels(cachedModels)
    void loadOpenRouterModels(false)
  }, [currentProvider.id, loadOpenRouterModels])

  const handleRefreshOpenCodeModels = () => {
    void loadOpenCodeModels(true)
  }

  const handleRefreshOpenRouterModels = () => {
    void loadOpenRouterModels(true)
  }

  const updateSetting = (key: keyof Settings, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }))
    if (key === 'ai_temperature' || key === 'ai_max_tokens') setAiTestResult(null)
  }

  const updateProviderConfig = (providerId: AIProviderId, field: keyof ProviderConfig, value: string) => {
    setProviderConfigs(prev => ({
      ...prev,
      [providerId]: { ...prev[providerId], [field]: value },
    }))
    setAiTestResult(null)
  }

  const handleProviderChange = (providerId: string) => {
    if (!AI_PROVIDERS[providerId as AIProviderId]) return
    setSettings(prev => ({ ...prev, ai_provider: providerId }))
    setAiTestResult(null)
  }

  const handleTestAI = async () => {
    setTestingAI(true)
    setAiTestResult(null)
    try {
      const result: AiTestResult = await testAiSettings({
        provider: currentProvider.id,
        apiKey: currentConfig.apiKey,
        baseUrl: currentConfig.baseUrl,
        model: currentConfig.model,
        temperature: Number(settings.ai_temperature),
        maxTokens: Number(settings.ai_max_tokens),
      })
      setAiTestResult(result)
      if (result.success) {
        toast.success(`AI 连接成功 (${result.provider}/${result.model})`)
      } else {
        toast.error(result.error || 'AI 连接失败')
      }
    } catch {
      setAiTestResult({ success: false, error: '请求失败' })
      toast.error('AI 连接测试失败')
    } finally {
      setTestingAI(false)
    }
  }

  const testModelAvailability = useCallback(async (
    provider: FreeAIProviderId,
    model: string,
  ): Promise<AiTestResult> => {
    const resultKey = getModelHealthKey(provider, model)
    setTestingModels((current) => ({ ...current, [resultKey]: true }))
    try {
      const result = await testSavedAiModel(provider, model)
      setModelTestResults((current) => ({ ...current, [resultKey]: result }))
      return result
    } catch (error) {
      const status = isRequestJsonError(error) ? error.status : undefined
      let errorKind: AiTestResult['errorKind'] = 'provider'
      if (status === 429) errorKind = 'rate_limit'
      else if (status === 401 || status === 403) errorKind = 'configuration'
      else if (status === 0 || (status !== undefined && status >= 500)) errorKind = 'network'
      const result: AiTestResult = {
        success: false,
        provider,
        model,
        error: error instanceof Error ? error.message : '测试请求失败',
        errorKind,
        status,
      }
      setModelTestResults((current) => ({ ...current, [resultKey]: result }))
      return result
    } finally {
      setTestingModels((current) => ({ ...current, [resultKey]: false }))
    }
  }, [])

  const handleTestAllModels = async () => {
    if (!currentHealthProvider) return
    const provider = currentHealthProvider
    const models = currentModelCandidates
      .slice()
      .sort((left, right) => Number(right === currentConfig.model) - Number(left === currentConfig.model))
      .map((model) => ({ provider, model }))
    if (models.length === 0) {
      toast.info(`${currentProvider.name} 暂未发现免费模型`)
      return
    }

    setTestingAllModels(true)
    setTestingProgress({ completed: 0, total: models.length })
    let availableCount = 0
    let slowCount = 0
    let stoppedByRateLimit = false
    let stoppedBySharedFailure = false
    let sharedFailureWasCooldown = false
    try {
      for (const [index, item] of models.entries()) {
        const result = await testModelAvailability(item.provider, item.model)
        setTestingProgress({ completed: index + 1, total: models.length })
        if (result.success) {
          availableCount++
          if (result.latencyMs !== undefined && result.latencyMs >= SLOW_MODEL_LATENCY_MS) slowCount++
          continue
        }

        // Key、余额、网络等属于厂商级故障，继续逐模型请求只会浪费时间和额度。
        if (isSharedHealthFailure(result)) {
          stoppedBySharedFailure = true
          sharedFailureWasCooldown = (result.retryAfterMs ?? 0) > 0
          const skippedResult = `${result.error || '厂商配置不可用'}；其余模型未继续请求`
          setModelTestResults((current) => {
            const next = { ...current }
            for (const remaining of models.slice(index + 1)) {
              const key = getModelHealthKey(remaining.provider, remaining.model)
              next[key] = { ...result, model: remaining.model, error: skippedResult }
            }
            return next
          })
          setTestingProgress({ completed: models.length, total: models.length })
          break
        }

        // 429 往往会触发 Provider 冷却；本轮停止，避免后续请求排队等待一分钟。
        if (result.errorKind === 'rate_limit' || result.status === 429) {
          stoppedByRateLimit = true
          break
        }
      }
      if (stoppedBySharedFailure) {
        if (sharedFailureWasCooldown) {
          toast.warning(`${currentProvider.name} 正在冷却，已跳过剩余模型测试`)
        } else {
          toast.error(`${currentProvider.name} 配置或网络不可用，已跳过剩余模型测试`)
        }
      } else if (stoppedByRateLimit) {
        toast.warning(`${currentProvider.name} 触发限流，已停止后续测试；剩余模型未测试`)
      } else {
        toast.success(`${currentProvider.name} 测试完成：${availableCount}/${models.length} 个模型可用${slowCount > 0 ? `，其中 ${slowCount} 个较慢` : ''}`)
      }
    } finally {
      setTestingAllModels(false)
    }
  }

  return (
    <Card className="mt-2 py-0">
      <CardContent className="space-y-3 p-3">
        <div className="flex items-center gap-2 border-b pb-2">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">AI 模型配置</span>
        </div>

        {/* Provider selector */}
        <div className="space-y-1">
          <Label className="text-xs">模型厂商</Label>
          <Select value={settings.ai_provider} onValueChange={handleProviderChange}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="选择模型厂商" />
            </SelectTrigger>
            <SelectContent className="rounded-none shadow-sm">
              {Object.values(AI_PROVIDERS).map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-xs">
                  {p.name}
                  {providerConfigs[p.id].apiKey ? ' ✓' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* API Key */}
        {currentProvider.needsApiKey && (
          <div className="space-y-1">
            <Label className="text-xs">API Key <span className="text-muted-foreground">({currentProvider.name})</span></Label>
            {sensitiveStatus !== 'ready' && (
              <div className="flex items-center justify-between gap-2 border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                <span>{sensitiveStatus === 'error' ? 'API Key 读取失败，已锁定编辑，避免覆盖已有密钥。' : '正在安全读取 API Key，暂不可编辑。'}</span>
                {sensitiveStatus === 'error' && (
                  <Button type="button" size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]" onClick={onRetrySensitive}>
                    重试
                  </Button>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={currentConfig.apiKey}
                  onChange={(e) => updateProviderConfig(currentProvider.id, 'apiKey', e.target.value)}
                  disabled={sensitiveStatus !== 'ready'}
                  className="h-8 pr-9 font-mono text-xs"
                  placeholder="sk-..."
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-8 w-8 px-0"
                  disabled={sensitiveStatus !== 'ready'}
                  onClick={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              留空表示保持原值不变。
            </p>
          </div>
        )}

        {/* Base URL */}
        {currentProvider.needsApiKey && (
          <div className="space-y-1">
            <Label className="text-xs">API 地址（默认已填充，可覆盖）</Label>
            <Input
              value={currentConfig.baseUrl}
              onChange={(e) => updateProviderConfig(currentProvider.id, 'baseUrl', e.target.value)}
              className="h-8 font-mono text-xs"
              placeholder="https://api.example.com/v1"
            />
          </div>
        )}

        {/* Model name */}
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">模型名称</Label>
            {currentHealthProvider && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-2 text-[11px]"
                disabled={testingAllModels || loadingOpenCodeModels || loadingOpenRouterModels}
                title={`绿色=可用，黄色=较慢，红色=不可用；本次最多消耗 ${currentModelCandidates.length} 次免费调用`}
                onClick={() => void handleTestAllModels()}
              >
                {testingAllModels ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {testingAllModels ? `测试中 ${testingProgress.completed}/${testingProgress.total}` : '测试全部'}
              </Button>
            )}
          </div>
          <Input
            value={currentConfig.model}
            onChange={(e) => updateProviderConfig(currentProvider.id, 'model', e.target.value)}
            className="h-8 font-mono text-xs"
            placeholder={currentProvider.defaultModel || '输入模型名称'}
          />
          {currentModelCandidates.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {currentModelCandidates.map((m) => {
                const resultKey = currentHealthProvider ? getModelHealthKey(currentHealthProvider, m) : ''
                const result = resultKey ? modelTestResults[resultKey] : undefined
                const testing = resultKey ? testingModels[resultKey] === true : false
                const status = getModelHealthStatus(result, testing)
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => updateProviderConfig(currentProvider.id, 'model', m)}
                    className={getModelChipClass(result, currentConfig.model === m, testing)}
                    aria-label={`${m}：${status.label}`}
                    title={`${m}：${status.label}${result?.success && result.latencyMs !== undefined ? `（${result.latencyMs}ms）` : result && !result.success && result.error ? `：${result.error}` : ''}`}
                  >
                    {m}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* AI Parameters */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs">Temperature <span className="text-muted-foreground">(0-2)</span></Label>
            <Input
              type="number"
              value={settings.ai_temperature}
              onChange={(e) => updateSetting('ai_temperature', e.target.value)}
              className="h-8 text-xs"
              min="0"
              max="2"
              step="0.1"
              placeholder="0.2"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Max Tokens <span className="text-muted-foreground">(1-65536)</span></Label>
            <Input
              type="number"
              value={settings.ai_max_tokens}
              onChange={(e) => updateSetting('ai_max_tokens', e.target.value)}
              className="h-8 text-xs"
              min="1"
              max="65536"
              step="256"
              placeholder="2048"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">AI 并发数 <span className="text-muted-foreground">(1-10)</span></Label>
            <Input
              type="number"
              value={settings.ai_concurrency}
              onChange={(e) => updateSetting('ai_concurrency', e.target.value)}
              className="h-8 text-xs"
              min="1"
              max="10"
              step="1"
              placeholder="1"
            />
            <p className="text-[11px] text-muted-foreground">
              OpenCode 免费请求约间隔 4 秒，OpenRouter 约间隔 3 秒并自动串行；其他服务商调高并发可缩短处理时间，但更容易触发限流。
            </p>
          </div>
        </div>

        {/* Test connection */}
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2.5 text-xs"
            // 不因本地 apiKey 空而禁用：reveal 未回显(401)时本地虽空，但 test-ai
            // 会从 DB 读真实 key；强制禁用会让无 token 用户连测试都点不动，卡死在
            // 「留空=保留」的循环里。本地有无 key 都允许点，交给服务端兜底。
            disabled={testingAI}
            onClick={handleTestAI}
          >
            {testingAI ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
            测试连接
          </Button>
          {aiTestResult && (
            <div className={`flex items-center gap-1.5 text-xs ${aiTestResult.success ? 'text-emerald-600' : 'text-destructive'}`}>
              {aiTestResult.success ? (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  <span>连接成功 ({aiTestResult.provider}/{aiTestResult.model})</span>
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4" />
                  <span>{aiTestResult.error}</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Refresh OpenCode models */}
        {currentProvider.id === 'opencode' && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[11px]"
              disabled={loadingOpenCodeModels}
              onClick={handleRefreshOpenCodeModels}
            >
              <RefreshCw className={`h-3 w-3 ${loadingOpenCodeModels ? 'animate-spin' : ''}`} />
              {loadingOpenCodeModels ? '读取中' : '刷新推荐'}
            </Button>
            <p className="text-[11px] text-muted-foreground">推荐项来自 OpenCode 免费模型列表</p>
          </div>
        )}

        {currentProvider.id === 'openrouter' && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[11px]"
              disabled={loadingOpenRouterModels}
              onClick={handleRefreshOpenRouterModels}
            >
              <RefreshCw className={`h-3 w-3 ${loadingOpenRouterModels ? 'animate-spin' : ''}`} />
              {loadingOpenRouterModels ? '读取中' : '刷新免费模型'}
            </Button>
            <p className="text-[11px] text-muted-foreground">列表来自 OpenRouter Models API</p>
          </div>
        )}

        {settings.ai_provider === 'opencode' && (
          <p className="text-xs text-muted-foreground">
            OpenCode Zen 仅允许免费模型调用，需先申请 API Key。申请地址：
            <a href="https://opencode.ai/auth" target="_blank" rel="noopener noreferrer" className="text-primary underline ml-1">opencode.ai/auth</a>
          </p>
        )}
        {settings.ai_provider === 'openrouter' && (
          <p className="text-xs text-muted-foreground">
            OpenRouter 默认使用 <code className="rounded bg-muted px-1">openrouter/free</code>，会自动选择可用的免费模型。请先填写 API Key；免费模型有速率限制。申请地址：
            <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-primary underline ml-1">openrouter.ai/keys</a>
          </p>
        )}
        {aiTestResult && !aiTestResult.success && aiTestResult.error?.includes('调用次数已用完') && (
          <p className="text-xs text-amber-600">
            今日调用次数已用完，请稍后重试或切换其他 AI 厂商。
          </p>
        )}
      </CardContent>
    </Card>
  )
}
