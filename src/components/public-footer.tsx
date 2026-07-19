import { Settings2 } from 'lucide-react'
import Link from 'next/link'

export default function PublicFooter() {
  return (
    <footer className="mt-12 border-t border-[var(--public-hairline)] bg-[var(--public-surface-soft)]">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-2 px-4 py-6 text-xs text-[var(--public-muted)] sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <Link
          href="/admin"
          aria-label="后台管理"
          title="后台管理"
          className="inline-flex h-8 w-8 items-center justify-center text-[var(--public-muted)] transition-colors hover:text-[var(--public-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]"
        >
          <Settings2 aria-hidden="true" className="h-4 w-4" strokeWidth={1.6} />
        </Link>
        <div>
          <span className="font-medium text-[var(--public-ink)]">行业新闻聚合</span>
          <span className="mx-2 text-[var(--public-hairline-strong)]">·</span>
          <span>精选行业动态与品牌资讯</span>
        </div>
      </div>
    </footer>
  )
}
