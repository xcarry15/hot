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
