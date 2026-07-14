export function StatusLight({ status, lastFetchedAt }: { status: string; lastFetchedAt?: string | null }) {
  const getStatus = (): { color: string; label: string } => {
    if (status === 'never_fetched' || (status === 'normal' && !lastFetchedAt)) {
      return { color: 'bg-zinc-300', label: '从未抓取' }
    }
    switch (status) {
      case 'normal': return { color: 'bg-emerald-500', label: '正常' }
      case 'warning': return { color: 'bg-amber-500', label: '警告' }
      case 'breaker': return { color: 'bg-red-500', label: '熔断' }
      default: return { color: 'bg-zinc-500', label: '禁用' }
    }
  }
  const { color, label } = getStatus()
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-block w-2 h-2 rounded-full ${color}`}
    />
  )
}
