'use client'

import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { CalendarClock } from 'lucide-react'
import { Settings } from './types'
import { DEFAULT_QUIET_END, DEFAULT_QUIET_START } from '@/lib/quiet-hours'

interface Props {
  settings: Settings
  setSettings: React.Dispatch<React.SetStateAction<Settings>>
}

/** 抓取节奏与免打扰配置，归属源管理（采集），与推送配置分离。 */
export default function CrawlConfig({ settings, setSettings }: Props) {
  const updateSetting = (key: keyof Settings, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }))
  }

  return (
    <div className="px-2 pb-2 pt-2">
      <Card className="py-0">
        <CardContent className="space-y-2 p-3">
          <div className="flex items-center gap-2 border-b pb-2">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">抓取配置</span>
          </div>

          <div className="flex items-center justify-between gap-3">
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

          <div className="space-y-1.5 border-t pt-2">
            <Label className="text-xs">免打扰时段</Label>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="crawl-quiet-start" className="text-[11px] text-muted-foreground">开始</Label>
                <Input
                  id="crawl-quiet-start"
                  type="time"
                  value={settings.crawl_quiet_start || DEFAULT_QUIET_START}
                  onChange={(e) => updateSetting('crawl_quiet_start', e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="crawl-quiet-end" className="text-[11px] text-muted-foreground">结束</Label>
                <Input
                  id="crawl-quiet-end"
                  type="time"
                  value={settings.crawl_quiet_end || DEFAULT_QUIET_END}
                  onChange={(e) => updateSetting('crawl_quiet_end', e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">时段内暂停自动抓取、自动恢复和自动推送；手动操作不受影响。支持跨午夜，默认 22:00–08:00；起止时间相同表示关闭免打扰。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
