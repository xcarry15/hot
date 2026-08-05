import type { CrawlRuntimeStatus } from '@/contracts/crawl-log'

interface RuntimeStatusBarProps {
  runtime?: CrawlRuntimeStatus
}

function formatTime(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date)
}

export function RuntimeStatusBar({ runtime }: RuntimeStatusBarProps) {
  const lastTime = formatTime(runtime?.lastCrawlAt) ?? '--:--'
  const countLabel = runtime?.lastCrawlCount == null ? '—' : `${runtime.lastCrawlCount}篇`
  const nextTime = formatTime(runtime?.nextCrawlAt ?? null) ?? '—'
  const label = `上次 ${lastTime} / ${countLabel} / 下次 ${nextTime}`

  return (
    <div
      className="min-w-0 flex-1 truncate px-1 text-[11px] leading-5 text-muted-foreground"
      title={label}
      aria-label={`自动化运行状态：${label}`}
    >
      <span>上次 {lastTime}</span>
      <span className="px-1">/</span>
      <span>{countLabel}</span>
      <span className="px-1">/</span>
      <span>下次 {nextTime}</span>
    </div>
  )
}
