'use client'

import { useState } from 'react'
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
} from 'lucide-react'
import { toast } from 'sonner'
import { testAiSettings, type AiTestResult } from '@/features/settings-api.client'
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
}

export default function AiModelTab({ settings, setSettings, providerConfigs, setProviderConfigs }: Props) {
  const [testingAI, setTestingAI] = useState(false)
  const [aiTestResult, setAiTestResult] = useState<AiTestResult | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)

  const currentProvider = AI_PROVIDERS[settings.ai_provider as AIProviderId] || AI_PROVIDERS.opencode
  const currentConfig = providerConfigs[currentProvider.id]

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

  return (
    <Card className="py-0">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">AI 模型配置</span>
        </div>

        {/* Provider selector */}
        <div className="space-y-1.5">
          <Label className="text-sm">模型厂商</Label>
          <Select value={settings.ai_provider} onValueChange={handleProviderChange}>
            <SelectTrigger className="h-9 text-sm">
              <SelectValue placeholder="选择模型厂商" />
            </SelectTrigger>
            <SelectContent>
              {Object.values(AI_PROVIDERS).map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-sm">
                  {p.name}
                  {providerConfigs[p.id].apiKey ? ' ✓' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* API Key */}
        {currentProvider.needsApiKey && (
          <div className="space-y-1.5">
            <Label className="text-sm">API Key <span className="text-muted-foreground">({currentProvider.name})</span></Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={currentConfig.apiKey}
                  onChange={(e) => updateProviderConfig(currentProvider.id, 'apiKey', e.target.value)}
                  className="h-9 text-sm pr-10 font-mono"
                  placeholder="sk-..."
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-9 w-9 px-0"
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
          <div className="space-y-1.5">
            <Label className="text-sm">API 地址（默认已填充，可覆盖）</Label>
            <Input
              value={currentConfig.baseUrl}
              onChange={(e) => updateProviderConfig(currentProvider.id, 'baseUrl', e.target.value)}
              className="h-9 text-sm font-mono"
              placeholder="https://api.example.com/v1"
            />
          </div>
        )}

        {/* Model name */}
        <div className="space-y-1.5">
          <Label className="text-sm">模型名称</Label>
          <Input
            value={currentConfig.model}
            onChange={(e) => updateProviderConfig(currentProvider.id, 'model', e.target.value)}
            className="h-9 text-sm font-mono"
            placeholder={currentProvider.defaultModel || '输入模型名称'}
          />
          {currentProvider.models.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {currentProvider.models.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => updateProviderConfig(currentProvider.id, 'model', m)}
                  className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                    currentConfig.model === m
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-muted/30 text-muted-foreground border-border hover:bg-muted'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* AI Parameters */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-sm">Temperature <span className="text-muted-foreground">(0-2)</span></Label>
            <Input
              type="number"
              value={settings.ai_temperature}
              onChange={(e) => updateSetting('ai_temperature', e.target.value)}
              className="h-9 text-sm"
              min="0"
              max="2"
              step="0.1"
              placeholder="0.2"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Max Tokens <span className="text-muted-foreground">(1-65536)</span></Label>
            <Input
              type="number"
              value={settings.ai_max_tokens}
              onChange={(e) => updateSetting('ai_max_tokens', e.target.value)}
              className="h-9 text-sm"
              min="1"
              max="65536"
              step="256"
              placeholder="10240"
            />
          </div>
        </div>

        {/* Test connection */}
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            className="h-9 px-3 gap-1.5"
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
            <div className={`flex items-center gap-1.5 text-sm ${aiTestResult.success ? 'text-emerald-600' : 'text-destructive'}`}>
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

        {settings.ai_provider === 'opencode' && (
          <p className="text-sm text-muted-foreground">
            OpenCode 提供免费模型调用，需先申请 API Key。申请地址：
            <a href="https://opencode.ai/auth" target="_blank" rel="noopener noreferrer" className="text-primary underline ml-1">opencode.ai/auth</a>
          </p>
        )}
        {aiTestResult && !aiTestResult.success && aiTestResult.error?.includes('调用次数已用完') && (
          <p className="text-sm text-amber-600">
            今日调用次数已用完，请稍后重试或切换其他 AI 厂商。
          </p>
        )}
      </CardContent>
    </Card>
  )
}
