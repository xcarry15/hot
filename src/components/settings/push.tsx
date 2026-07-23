'use client'

import { useState, useCallback, useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Loader2,
  Send,
  Plus,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Settings, WebhookConfig, WebhookTestResult } from './types'
import {
  WEBHOOK_MAX_COUNT,
  parseWebhookConfigs,
  serializeWebhookConfigsForEditor,
} from '@/contracts/webhook'
import { previewPushSettings, testWebhook as testWebhookApi, type PushPreviewResult } from '@/features/settings-api.client'


interface Props {
  settings: Settings
  setSettings: React.Dispatch<React.SetStateAction<Settings>>
}

/** 编辑态序列化：保留空输入条目，便于用户继续填写 */
const serializeWebhooks = serializeWebhookConfigsForEditor

export default function PushTab({ settings, setSettings }: Props) {
  // 从 settings JSON 字符串派生 webhook 列表
  const webhooks = useMemo(() => parseWebhookConfigs(settings.feishu_webhook_url), [settings.feishu_webhook_url])

  // 各 webhook 的测试状态
  const [testStates, setTestStates] = useState<Record<number, { testing: boolean; result: WebhookTestResult | null }>>({})
  const [preview, setPreview] = useState<PushPreviewResult | null>(null)
  const [previewing, setPreviewing] = useState(false)

  const updateSetting = useCallback((key: keyof Settings, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }))
  }, [setSettings])

  /** 更新单个 webhook 字段 */
  const updateWebhook = useCallback((index: number, field: keyof WebhookConfig, value: string | boolean) => {
    const next = webhooks.map((w, i) => i === index ? { ...w, [field]: value } : w)
    updateSetting('feishu_webhook_url', serializeWebhooks(next))
  }, [webhooks, updateSetting])

  /** 删除 webhook */
  const removeWebhook = useCallback((index: number) => {
    const next = webhooks.filter((_, i) => i !== index)
    updateSetting('feishu_webhook_url', serializeWebhooks(next))
    setTestStates(prev => {
      const next2: Record<number, { testing: boolean; result: WebhookTestResult | null }> = {}
      Object.entries(prev).forEach(([k, v]) => {
        const oldIdx = parseInt(k)
        if (oldIdx < index) next2[oldIdx] = v
        else if (oldIdx > index) next2[oldIdx - 1] = v
      })
      return next2
    })
  }, [webhooks, updateSetting])

  /** 添加新 webhook */
  const addWebhook = useCallback(() => {
    if (webhooks.length >= WEBHOOK_MAX_COUNT) {
      toast.warning(`最多支持 ${WEBHOOK_MAX_COUNT} 个 Webhook`)
      return
    }
    const next = [...webhooks, { url: '', remark: '', enabled: true }]
    updateSetting('feishu_webhook_url', serializeWebhooks(next))
  }, [webhooks, updateSetting])

  /** 测试单个 webhook */
  const testWebhook = useCallback(async (index: number, url: string) => {
    if (!url.trim()) {
      toast.error('请先填写 Webhook URL')
      return
    }
    setTestStates(prev => ({ ...prev, [index]: { testing: true, result: null } }))
    try {
      const result = await testWebhookApi(url)
      setTestStates(prev => ({ ...prev, [index]: { testing: false, result } }))
      if (result.success) {
        toast.success(`Webhook "${webhooks[index]?.remark || '未命名'}" 测试成功！`)
      } else {
        toast.error(result.error || 'Webhook 测试失败')
      }
    } catch {
      setTestStates(prev => ({
        ...prev,
        [index]: { testing: false, result: { success: false, error: '请求失败' } },
      }))
      toast.error('Webhook 测试失败')
    }
  }, [webhooks])

  const anyTesting = useMemo(
    () => Object.values(testStates).some(s => s.testing),
    [testStates]
  )

  const previewPush = useCallback(async () => {
    setPreviewing(true)
    try {
      setPreview(await previewPushSettings({ minScore: Number(settings.push_min_score) || 0, minRelevance: Number(settings.push_min_relevance) || 0, pushMode: settings.push_mode }))
    } catch { toast.error('推送规则预览失败') } finally { setPreviewing(false) }
  }, [settings.push_min_relevance, settings.push_min_score, settings.push_mode])

  return (
    <div className="space-y-2 pt-2">
      {/* 飞书推送配置 */}
      <Card className="py-0">
        <CardContent className="space-y-2.5 p-3">
          <div className="flex items-center gap-2 border-b pb-2">
            <Send className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">飞书推送配置</span>
          </div>

          {/* ── Webhook URL 列表 ── */}
          <div className="space-y-1.5">
            <Label className="text-xs">Webhook URL</Label>
            <p className="text-xs text-muted-foreground">支持配置多个 Webhook URL，推送时依次发送。可添加备注区分不同飞书群。</p>

            <div className="mt-1.5 space-y-1">
              {webhooks.length === 0 && (
                <div className="border border-dashed py-3 text-center text-xs text-muted-foreground">
                  暂未配置 Webhook，点击下方按钮添加
                </div>
              )}

              {webhooks.map((webhook, index) => {
                const ts = testStates[index]
                return (
                  <div key={index} className={`flex items-center gap-1.5 border p-1.5 ${webhook.enabled ? '' : 'opacity-50 bg-muted/20'}`}>
                    <Switch
                      checked={webhook.enabled}
                      onCheckedChange={(checked) => updateWebhook(index, 'enabled', checked)}
                      aria-label={webhook.enabled ? '禁用此 Webhook' : '启用此 Webhook'}
                      className="scale-75 origin-center shrink-0"
                    />
                    <Input
                      value={webhook.url}
                      onChange={(e) => updateWebhook(index, 'url', e.target.value)}
                      className="h-8 text-xs flex-1 font-mono"
                      placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                    />
                    <Input
                      value={webhook.remark}
                      onChange={(e) => updateWebhook(index, 'remark', e.target.value)}
                      className="h-8 text-xs w-20 shrink-0"
                      placeholder="备注"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 shrink-0"
                      disabled={ts?.testing || !webhook.url.trim()}
                      onClick={() => testWebhook(index, webhook.url)}
                    >
                      {ts?.testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-1.5 shrink-0 text-muted-foreground hover:text-destructive"
                      disabled={anyTesting}
                      onClick={() => removeWebhook(index)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    {ts?.result && (
                      <span className={`text-xs shrink-0 ${ts.result.success ? 'text-emerald-600' : 'text-destructive'}`}>
                        {ts.result.success ? '✓' : `✕ ${ts.result.error}`}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>

            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2.5 text-xs"
              disabled={webhooks.length >= WEBHOOK_MAX_COUNT || anyTesting}
              onClick={addWebhook}
            >
              <Plus className="h-3.5 w-3.5" />
              添加 Webhook
              {webhooks.length > 0 && ` (${webhooks.length}/${WEBHOOK_MAX_COUNT})`}
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">推送模式</Label>
            <RadioGroup
              value={settings.push_mode}
              onValueChange={(v) => updateSetting('push_mode', v)}
              className="flex gap-4"
            >
              <div className="flex items-center gap-1.5">
                <RadioGroupItem value="realtime" id="realtime" />
                <Label htmlFor="realtime" className="text-xs font-normal">实时推送</Label>
              </div>
              <div className="flex items-center gap-1.5">
                <RadioGroupItem value="batch" id="batch" />
                <Label htmlFor="batch" className="text-xs font-normal">批量推送</Label>
              </div>
              <div className="flex items-center gap-1.5">
                <RadioGroupItem value="off" id="off" />
                <Label htmlFor="off" className="text-xs font-normal">关闭</Label>
              </div>
            </RadioGroup>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {settings.push_mode === 'batch' ? (
              <div className="space-y-1.5">
                <Label className="text-xs">推送时间</Label>
                <Input
                  type="time"
                  value={settings.push_time.startsWith('cron:') ? '08:30' : settings.push_time}
                  onChange={(e) => updateSetting('push_time', e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs">推送时间</Label>
                <div className="flex h-8 items-center border border-dashed bg-muted/30 px-3 text-xs text-muted-foreground">
                  {settings.push_mode === 'realtime' ? '实时推送：每轮抓取分析完成后立即推送' : '已关闭推送'}
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">最低推送评分</Label>
              <Input
                type="number"
                value={settings.push_min_score}
                onChange={(e) => updateSetting('push_min_score', e.target.value)}
                className="h-8 text-xs"
                min="0"
                max="100"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">最低相关度</Label>
              <Input
                type="number"
                value={settings.push_min_relevance}
                onChange={(e) => updateSetting('push_min_relevance', e.target.value)}
                className="h-8 text-xs"
                min="0"
                max="100"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-2">
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={previewing} onClick={() => void previewPush()}>{previewing ? '预览中…' : '预览推送结果'}</Button>
            {preview && <span className="text-xs text-muted-foreground">当前约 {preview.pushable} 篇符合阈值；{preview.webhookCount} 个 Webhook 可用，预计本轮推送 {preview.willPush} 篇。</span>}
          </div>

        </CardContent>
      </Card>

      {/* 抓取配置 */}
      <Card className="py-0">
        <CardContent className="space-y-2 p-3">
          <span className="text-sm font-semibold">抓取配置</span>
          <div className="flex items-center justify-between gap-3 border-b pb-2">
            <div>
              <Label htmlFor="auto-crawl-enabled" className="text-xs">启用自动抓取</Label>
              <p className="mt-0.5 text-[11px] text-muted-foreground">关闭后仍可手动执行抓取；默认关闭。</p>
            </div>
            <Switch
              id="auto-crawl-enabled"
              checked={settings.auto_crawl_enabled === 'true'}
              onCheckedChange={(checked) => updateSetting('auto_crawl_enabled', checked ? 'true' : 'false')}
              aria-label="启用自动抓取"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="crawl-interval-min" className="text-xs">抓取间隔（分钟）</Label>
            <Input
              id="crawl-interval-min"
              type="number"
              value={settings.crawl_interval_min}
              onChange={(e) => updateSetting('crawl_interval_min', e.target.value)}
              className="h-8 w-28 text-xs"
              min="5"
              max="10080"
            />
            <p className="text-[11px] text-muted-foreground">自动抓取开启后，调度器按此间隔检查并创建全流程任务。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
