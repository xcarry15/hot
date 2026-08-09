import type { ReactNode } from 'react'
import PublicFooter from '@/components/public-footer'
import PublicHeader, { type PublicNavKey } from '@/components/public-header'

interface Props {
  active?: PublicNavKey
  children: ReactNode
  mainClassName: string
  readingProgress?: boolean
}

export default function PublicPageShell({ active, children, mainClassName, readingProgress = false }: Props) {
  return (
    <div className="public-site flex min-h-[100dvh] flex-col bg-background text-foreground">
      <PublicHeader active={active} readingProgress={readingProgress} />
      <main className={`mx-auto w-full max-w-[1200px] flex-1 ${mainClassName}`}>{children}</main>
      <PublicFooter />
    </div>
  )
}
