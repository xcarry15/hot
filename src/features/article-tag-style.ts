export function getTagToneClass(tone: string): string {
  const map: Record<string, string> = {
    '正': 'text-emerald-600 border-transparent',
    '负': 'text-red-600 border-transparent',
    '中': 'text-zinc-500 border-transparent',
    '警': 'text-amber-600 border-transparent',
    '机': 'text-blue-600 border-transparent',
  }
  return map[tone] || map['中']
}

