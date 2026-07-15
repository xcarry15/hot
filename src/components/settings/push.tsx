'use client'

import { useState, useCallback, useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Loader2,
  Send,
  Plus,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Settings, WebhookConfig, WebhookTestResult } from './types'
import { Switch } from '@/components/ui/switch'
import { DEDUP_SETTING_DEFINITIONS } from '@/contracts/dedup-settings'
import {
  WEBHOOK_MAX_COUNT,
  parseWebhookConfigs,
  serializeWebhookConfigsForEditor,
} from '@/contracts/webhook'
import { testWebhook as testWebhookApi } from '@/features/settings-api.client'

// 去重阈值：UI 唯一来源。push.tsx 渲染、settings-tab.tsx 初始值、API 校验共用这套边界。
interface DedupFieldDef {
  key: keyof Settings
  label: string
  defaultValue: string
  min: number
  max: number
  step?: number
  description: string
  fullWidth?: boolean
}

const DEDUP_FIELDS: readonly DedupFieldDef[] = [
  { ...DEDUP_SETTING_DEFINITIONS.windowDays, label: '比对时间范围（天）', description: '只与最近 N 天内的文章比对，超过的视为新事件' },
  { ...DEDUP_SETTING_DEFINITIONS.numericSharedMin, label: '数字特征匹配数', description: '两篇出现 N 个相同数字，且至少包含一个有区分度的事实值，才判为同一事件' },
  { ...DEDUP_SETTING_DEFINITIONS.bodyLcsMin, label: '单段重复最少字数', description: '连续相同的字数达到此值才算一段重复，默认更保守' },
  { ...DEDUP_SETTING_DEFINITIONS.lcsTotalMin, label: '重复字数累计阈值', step: 50, description: '所有重复片段字数累加达到此值才最终判重，默认更保守' },
  { ...DEDUP_SETTING_DEFINITIONS.shortBodyThreshold, label: '短文额外比对上限', step: 100, description: '两篇都低于此字数时启用补充比对，调大去重更激进', fullWidth: true },
] as const

const BRAND_GATE_SETTING = DEDUP_SETTING_DEFINITIONS.brandGateEnabled

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

  return (
    <div className="space-y-3">
      {/* 飞书推送配置 */}
      <Card className="py-0">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Send className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">飞书推送配置</span>
          </div>

          {/* ── Webhook URL 列表 ── */}
          <div className="space-y-1.5">
            <Label className="text-xs">Webhook URL</Label>
            <p className="text-xs text-muted-foreground">支持配置多个 Webhook URL，推送时依次发送。可添加备注区分不同飞书群。</p>

            <div className="space-y-1.5 mt-1.5">
              {webhooks.length === 0 && (
                <div className="text-xs text-muted-foreground py-3 border border-dashed rounded-lg text-center">
                  暂未配置 Webhook，点击下方按钮添加
                </div>
              )}

              {webhooks.map((webhook, index) => {
                const ts = testStates[index]
                return (
                  <div key={index} className={`flex items-center gap-2 p-2 rounded-lg border ${webhook.enabled ? '' : 'opacity-50 bg-muted/20'}`}>
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
              className="h-8 px-3 gap-1.5 text-xs"
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
                <div className="h-8 px-3 flex items-center text-xs text-muted-foreground bg-muted/30 rounded-md border border-dashed">
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

          <div className="space-y-2">
            <span className="text-xs font-semibold">去重规则</span>
            <p className="text-[11px] text-muted-foreground">
              以下参数控制「两篇文章是否重复」的判断标准。默认值已适配通用场景，谨慎调整。
            </p>

            <div className="flex items-center justify-between gap-2 p-2 rounded-lg border bg-muted/20">
              <div className="space-y-0.5 min-w-0">
                <Label htmlFor="brand-gate" className="text-xs">仅同品牌判重</Label>
                <p className="text-[11px] text-muted-foreground truncate">开启后不同品牌的文章不会合并（推荐开启）</p>
              </div>
              <Switch
                id="brand-gate"
                checked={(settings[BRAND_GATE_SETTING.key] || BRAND_GATE_SETTING.defaultValue) === 'true'}
                onCheckedChange={(checked) => updateSetting(BRAND_GATE_SETTING.key, checked ? 'true' : 'false')}
                aria-label="仅同品牌判重"
                className="scale-90 shrink-0"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {DEDUP_FIELDS.map((f) => (
                <div key={f.key} className={f.fullWidth ? 'sm:col-span-2' : ''}>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs shrink-0">{f.label}</Label>
                    <Input
                      type="number"
                      value={(settings[f.key] as string) || f.defaultValue}
                      min={f.min}
                      max={f.max}
                      step={f.step}
                      onChange={(e) => updateSetting(f.key, e.target.value)}
                      className="h-7 text-xs w-[72px]"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{f.description}</p>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 抓取配置 */}
      <Card className="py-0">
        <CardContent className="p-4 space-y-3">
          <span className="text-sm font-semibold">抓取配置</span>
          <div className="space-y-1.5">
            <Label className="text-xs">抓取间隔（分钟）</Label>
            <Input
              type="number"
              value={settings.crawl_interval_min}
              onChange={(e) => updateSetting('crawl_interval_min', e.target.value)}
              className="h-8 text-xs w-28"
              min="5"
              max="10080"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
