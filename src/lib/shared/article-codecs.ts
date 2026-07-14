/** 文章字段的纯解析函数。 */
export function parseJsonArray(str: string): string[] {
  try {
    const parsed = JSON.parse(str)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim()
}

export function parseTags(str: string): { name: string; tone: string }[] {
  try {
    const parsed = JSON.parse(str)
    if (Array.isArray(parsed)) {
      return parsed
        .map((item: unknown) => {
          if (typeof item === 'string') return { name: item, tone: '中' }
          if (typeof item === 'object' && item !== null) {
            const obj = item as Record<string, unknown>
            return { name: String(obj.n || '').trim(), tone: String(obj.t || '中') }
          }
          return { name: '', tone: '中' }
        })
        .filter((x: { name: string }) => x.name.length > 0)
    }
  } catch {
    // fall through to comma-separated fallback
  }
  return str
    ? str.split(/[,，]/).map(s => ({ name: s.trim(), tone: '中' })).filter(x => x.name)
    : []
}

export function splitBrands(str: string): string[] {
  if (!str) return []
  try {
    const parsed = JSON.parse(str)
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean)
  } catch {
    // 兼容历史的 | / 中英文逗号格式。
  }
  return str.split(/[|,，]/).map(s => s.trim()).filter(Boolean)
}
