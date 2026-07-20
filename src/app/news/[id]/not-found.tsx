import Link from 'next/link'
import PublicFooter from '@/components/public-footer'
import PublicHeader from '@/components/public-header'

export default function PublicArticleNotFound() {
  return (
    <div className="public-site flex min-h-[100dvh] flex-col bg-background text-foreground">
      <PublicHeader active="articles" />
      <main className="mx-auto flex w-full max-w-[1200px] flex-1 items-center justify-center px-4 py-16 sm:px-6">
        <section className="public-section-enter w-full max-w-md border border-[var(--public-hairline)] bg-[var(--public-surface)] px-6 py-14 text-center">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-[var(--public-primary)]">404</p>
          <h1 className="public-display mt-3 text-3xl text-[var(--public-ink)]">文章不存在</h1>
          <p className="mt-3 text-sm leading-7 text-[var(--public-muted)]">这篇文章可能已经下线，或者当前不满足公开条件。</p>
          <Link href="/" className="public-pressable mt-6 inline-flex h-10 items-center bg-[var(--public-primary)] px-4 text-sm font-medium text-white transition-colors hover:bg-[var(--public-primary-active)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color:rgb(204_120_92_/_0.25)]">返回文章列表</Link>
        </section>
      </main>
      <PublicFooter />
    </div>
  )
}
