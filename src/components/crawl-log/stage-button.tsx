import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'

// ========== Stage Button ==========

export function StageButton({
  label,
  loading,
  disabled,
  onClick,
  className = '',
}: {
  label: string
  loading: boolean
  disabled: boolean
  onClick: () => void
  className?: string
}) {
  const display = loading ? `${label}中` : label
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={onClick}
      disabled={disabled}
      className={`h-7 rounded-none gap-1 px-2 text-xs whitespace-nowrap ${className}`}
      title={loading ? `${label}中...` : label}
    >
      {loading && <Loader2 className="h-3 w-3 animate-spin" />}
      <span>{display}</span>
    </Button>
  )
}
