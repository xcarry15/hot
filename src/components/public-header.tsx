'use client'

import Link from 'next/link'
import PublicReadingProgress from '@/components/public-reading-progress'
import { PUBLIC_SITE_NAME, PUBLIC_SITE_TAGLINE } from '@/lib/public-brand'
import logo from '@/pic/Logo/icon-192x192.png'

export type PublicNavKey = 'articles' | 'tools' | 'about'

const PUBLIC_NAV_ITEMS: Array<{ key: PublicNavKey; label: string; href: string }> = [
  { key: 'articles', label: '资讯', href: '/' },
  { key: 'tools', label: '工具', href: '/tools' },
  { key: 'about', label: '关于', href: '/about' },
]

interface Props {
  active?: PublicNavKey
  readingProgress?: boolean
}

export default function PublicHeader({ active, readingProgress = false }: Props) {
  function renderNavItems(mobile = false) {
    return PUBLIC_NAV_ITEMS.map((item) => {
      const isActive = item.key === active
      return (
        <Link
          key={item.key}
          href={item.href}
          aria-current={isActive ? 'page' : undefined}
          className={`${mobile ? 'public-pressable inline-flex h-7 items-center px-3' : 'public-pressable inline-flex h-10 w-14 shrink-0 items-center justify-center px-3 py-2'} text-sm font-medium transition-colors ${isActive ? 'bg-[var(--public-surface-strong)] text-[var(--public-ink)]' : 'text-[var(--public-muted)] hover:bg-[var(--public-surface-soft)] hover:text-[var(--public-ink)]'}`}
        >
          {item.label}
        </Link>
      )
    })
  }

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--public-hairline)] bg-[var(--public-canvas)]/95 backdrop-blur supports-[backdrop-filter]:bg-[var(--public-canvas)]/85">
      <div className="mx-auto flex min-h-14 max-w-[1200px] items-center gap-3 px-4 sm:min-h-16 sm:gap-4 sm:px-6 md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <Link href="/" className="public-pressable flex min-w-0 items-center gap-2 sm:gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)]">
          <img src={logo.src} alt={PUBLIC_SITE_NAME} width="36" height="36" className="h-8 w-8 sm:h-9 sm:w-9" />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight text-[var(--public-ink)] sm:text-base">{PUBLIC_SITE_NAME}</h1>
            <p className="hidden truncate text-xs text-[var(--public-muted)] sm:block">{PUBLIC_SITE_TAGLINE}</p>
          </div>
        </Link>

        <nav className="hidden w-[174px] grid-cols-3 items-center gap-1 md:grid md:justify-self-center" aria-label="公开导航">
          {renderNavItems()}
        </nav>

      </div>

      <div id="public-mobile-navigation" className="public-mobile-navigation relative px-4 py-1 md:hidden">
        <nav className="mx-auto flex max-w-[1200px] items-center gap-1" aria-label="移动端公开导航">
          {renderNavItems(true)}
        </nav>
      </div>
      {readingProgress && <PublicReadingProgress />}
    </header>
  )
}
