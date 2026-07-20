'use client'

import Link from 'next/link'
import { RefreshCw } from 'lucide-react'
import PublicFooter from '@/components/public-footer'
import PublicHeader from '@/components/public-header'

interface Props {
  detail?: boolean
}

export default function PublicErrorState({ detail = false }: Props) {
  return (
    <div className="public-site flex min-h-[100dvh] flex-col bg-background text-foreground">
      <PublicHeader active="articles" />
      <main className="mx-auto flex w-full max-w-[1200px] flex-1 items-center justify-center px-4 py-16 sm:px-6">
        <section className="public-section-enter w-full max-w-md border border-[var(--public-hairline)] bg-[var(--public-surface)] px-6 py-14 text-center">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-[var(--public-primary)]">暂时无法加载</p>
          <h1 className="public-display mt-3 text-3xl text-[var(--public-ink)]">{detail ? '文章暂时不可用' : '文章列表暂时不可用'}</h1>
          <p className="mt-3 text-sm leading-7 text-[var(--public-muted)]">请稍后重试，或返回文章列表继续浏览。</p>
          <div className="mt-6 flex justify-center gap-2"><button type="button" onClick={() => window.location.reload()} className="public-pressable inline-flex h-10 items-center gap-1.5 border border-[var(--public-hairline-strong)] px-4 text-sm font-medium text-[var(--public-ink)] transition-colors hover:border-[var(--public-primary)] hover:text-[var(--public-primary)]"><RefreshCw className="h-3.5 w-3.5" />重试</button><Link href="/" className="public-pressable inline-flex h-10 items-center bg-[var(--public-primary)] px-4 text-sm font-medium text-white transition-colors hover:bg-[var(--public-primary-active)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color:rgb(204_120_92_/_0.25)]">返回文章列表</Link></div>
        </section>
      </main>
      <PublicFooter />
    </div>
  )
}
