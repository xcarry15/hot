export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '从未抓取'
  const now = new Date()
  const date = new Date(dateStr)
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin}分钟前`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}小时前`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay}天前`
  return date.toLocaleDateString('zh-CN')
}

export function formatDaysAgo(value: Date | string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000)))
  return days === 0 ? '今天' : `${days}天前`
}
