// ========== Helpers ==========

export function formatPubDate(input?: string | null): string {
  if (!input) return ''
  const d = new Date(input)
  if (isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  // UTC 午夜（列表页仅有日期）→ 只显示日期，避免误导为 08:00
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) {
    return `${mm}-${dd}`
  }
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

export function formatLastTime(input?: string | number | null): string {
  if (!input) return ''
  const date = new Date(input)
  if (isNaN(date.getTime())) return ''

  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => String(value).padStart(2, '0'))
    .join(':')
  if (date.toDateString() === new Date().toDateString()) return time

  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}-${day} ${time}`
}

export function formatShortTime(input?: string | number | null): string {
  if (!input) return ''
  const date = new Date(input)
  if (isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export const DISCARD_REASON_LABELS: Record<string, string> = {
  'dedup:url': '链接已存在',
  'filter:keyword': '未命中关键词',
  'filter:blacklist': '黑名单',
  'filter:short': '内容过短',
}
