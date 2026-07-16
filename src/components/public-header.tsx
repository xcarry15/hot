'use client'

import { Menu, X } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'

export type PublicNavKey = 'articles' | 'tools'

/**
 * Public navigation targets. Leave future page hrefs empty until their routes
 * are ready; the header will render them as disabled placeholders meanwhile.
 */
const PUBLIC_NAV_ITEMS: Array<{ key: PublicNavKey; label: string; href: string }> = [
  { key: 'articles', label: '文章', href: '/' },
  { key: 'tools', label: '工具', href: '/tools' },
]

interface Props {
  active?: PublicNavKey
}

export default function PublicHeader({ active = 'articles' }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false)

  function closeMobileMenu() {
    setMobileOpen(false)
  }

  function renderNavItems(mobile = false) {
    return PUBLIC_NAV_ITEMS.map((item) => {
      const isActive = item.key === active
      if (!item.href) {
        return (
          <span
            key={item.key}
            aria-disabled="true"
            title={`${item.label}页面即将上线`}
            className={`${mobile ? 'block w-full px-3 py-3' : 'inline-flex h-10 w-14 shrink-0 items-center justify-center rounded-none px-3 py-2'} text-sm font-medium text-[var(--public-muted-soft)]`}
          >
            {item.label}
          </span>
        )
      }
      return (
        <Link
          key={item.key}
          href={item.href}
          aria-current={isActive ? 'page' : undefined}
          onClick={mobile ? closeMobileMenu : undefined}
          className={`${mobile ? 'block w-full px-3 py-3' : 'inline-flex h-10 w-14 shrink-0 items-center justify-center rounded-none px-3 py-2'} text-sm font-medium transition-colors ${isActive ? 'bg-[var(--public-surface-strong)] text-[var(--public-ink)]' : 'text-[var(--public-muted)] hover:bg-[var(--public-surface-soft)] hover:text-[var(--public-ink)]'}`}
        >
          {item.label}
        </Link>
      )
    })
  }

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--public-hairline)] bg-[var(--public-canvas)]/95 backdrop-blur supports-[backdrop-filter]:bg-[var(--public-canvas)]/85">
      <div className="mx-auto flex min-h-16 max-w-[1200px] items-center gap-4 px-4 sm:px-6 md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <Link href="/" onClick={closeMobileMenu} className="flex min-w-0 items-center gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)]">
          <img src="/icon-192x192.png" alt="新闻聚合" className="h-9 w-9 rounded-none" />
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight text-[var(--public-ink)]">行业新闻聚合</h1>
            <p className="truncate text-xs text-[var(--public-muted)]">精选行业动态与品牌资讯</p>
          </div>
        </Link>

        <nav className="hidden w-[116px] grid-cols-2 items-center gap-1 md:grid md:justify-self-center" aria-label="公开导航">
          {renderNavItems()}
        </nav>

        <div className="ml-auto flex items-center md:ml-0 md:justify-self-end">
          <button
            type="button"
            aria-label={mobileOpen ? '关闭导航菜单' : '打开导航菜单'}
            aria-expanded={mobileOpen}
            aria-controls="public-mobile-navigation"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md text-[var(--public-ink)] transition-colors hover:bg-[var(--public-surface-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] md:hidden"
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <X aria-hidden="true" className="h-5 w-5" /> : <Menu aria-hidden="true" className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div id="public-mobile-navigation" className="border-t border-[var(--public-hairline)] px-4 py-3 md:hidden">
          <nav className="mx-auto max-w-[1200px] space-y-1" aria-label="移动端公开导航">
            {renderNavItems(true)}
          </nav>
        </div>
      )}
    </header>
  )
}
