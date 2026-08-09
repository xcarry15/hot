import type { ReactNode } from 'react'
import PublicPageShell from '@/components/public-page-shell'

interface Props {
  actions: ReactNode
  description: string
  eyebrow: string
  title: string
}

export default function PublicMessagePage({ actions, description, eyebrow, title }: Props) {
  return (
    <PublicPageShell active="articles" mainClassName="flex items-center justify-center px-4 py-16 sm:px-6">
      <section className="public-section-enter w-full max-w-md border border-[var(--public-hairline)] bg-[var(--public-surface)] px-6 py-14 text-center">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-[var(--public-primary)]">{eyebrow}</p>
        <h1 className="public-display mt-3 text-3xl text-[var(--public-ink)]">{title}</h1>
        <p className="mt-3 text-sm leading-7 text-[var(--public-muted)]">{description}</p>
        <div className="mt-6 flex justify-center gap-2">{actions}</div>
      </section>
    </PublicPageShell>
  )
}
