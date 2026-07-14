import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'

// ========== Stage Button ==========

export function StageButton({
  label,
  icon: Icon,
  loading,
  disabled,
  onClick,
  className = '',
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
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
      className={`h-8 gap-1.5 text-xs sm:text-sm px-2 sm:px-3 whitespace-nowrap ${className}`}
      title={loading ? `${label}中...` : label}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Icon className="h-3.5 w-3.5" />
      )}
      <span>{display}</span>
    </Button>
  )
}
