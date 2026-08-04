import { Button } from '@/components/ui/button'

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
      className={`px-2 text-xs whitespace-nowrap ${className}`}
      title={loading ? `${label}中...` : label}
    >
      <span>{display}</span>
    </Button>
  )
}
