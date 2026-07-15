import Link from 'next/link'

export type PublicNavKey = 'articles' | 'tools' | 'data'

/**
 * Public navigation targets. Leave future page hrefs empty until their routes
 * are ready; the header will render them as disabled placeholders meanwhile.
 */
const PUBLIC_NAV_ITEMS: Array<{ key: PublicNavKey; label: string; href: string }> = [
  { key: 'articles', label: '文章', href: '/' },
  { key: 'tools', label: '工具', href: '' },
  { key: 'data', label: '数据', href: '' },
]

interface Props {
  active?: PublicNavKey
}

export default function PublicHeader({ active = 'articles' }: Props) {
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-4 py-4 sm:px-6">
        <Link href="/" className="flex min-w-0 items-center gap-3">
          <img src="/icon-192x192.png" alt="新闻聚合" className="h-9 w-9 rounded-md" />
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight">行业新闻聚合</h1>
            <p className="text-xs text-muted-foreground">精选行业动态与品牌资讯</p>
          </div>
        </Link>

        <nav className="flex items-center gap-1" aria-label="公开导航">
          {PUBLIC_NAV_ITEMS.map((item) => {
            const isActive = item.key === active
            if (!item.href) {
              return (
                <span
                  key={item.key}
                  aria-disabled="true"
                  title={`${item.label}页面即将上线`}
                  className="rounded-md px-3 py-2 text-sm text-muted-foreground/45"
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
                className={`rounded-md px-3 py-2 text-sm transition-colors ${isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'}`}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
