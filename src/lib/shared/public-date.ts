export const PUBLIC_TIME_ZONE = 'Asia/Shanghai'

type DateInput = Date | string | number

function dateParts(value: DateInput): Record<string, string> {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: PUBLIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value)).reduce<Record<string, string>>((parts, part) => {
    if (part.type !== 'literal') parts[part.type] = part.value
    return parts
  }, {})
}

export function getPublicDateKey(value: DateInput): string {
  const parts = dateParts(value)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function getPublicDateLabel(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00+08:00`)
  if (Number.isNaN(date.getTime())) return dateKey
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: PUBLIC_TIME_ZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(date).replace(/日(?=星期)/, '日 ')
}

export function getPublicDayLabel(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00+08:00`)
  if (Number.isNaN(date.getTime())) return dateKey
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: PUBLIC_TIME_ZONE,
    day: 'numeric',
    weekday: 'long',
  }).format(date).replace(/日(?=星期)/, '日 ')
}

export function getPublicMonthLabel(dateKey: string): string {
  const date = new Date(`${dateKey.slice(0, 7)}-01T00:00:00+08:00`)
  if (Number.isNaN(date.getTime())) return dateKey.slice(0, 7)
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: PUBLIC_TIME_ZONE,
    year: 'numeric',
    month: 'long',
  }).format(date)
}

export function formatPublicTime(value: DateInput): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--:--'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: PUBLIC_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export function formatPublicDateTime(value: DateInput): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: PUBLIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}
