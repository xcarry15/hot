'use client'

import { Check, Copy, ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface Props {
  href: string
  articleId: string
  shareUrl?: string
  className?: string
}

export function PublicShareButton({ shareUrl, className }: { shareUrl: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const handleShare = async () => {
    try {
      if (navigator.share) await navigator.share({ title: document.title, url: shareUrl })
      else {
        await navigator.clipboard.writeText(shareUrl)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      }
    } catch { /* 用户取消分享或浏览器拒绝剪贴板时不打断阅读 */ }
  }
  return <button type="button" onClick={() => void handleShare()} className={`inline-flex h-7 items-center gap-1 px-2 text-xs text-[var(--public-muted)] transition-colors hover:bg-[var(--public-surface-soft)] hover:text-[var(--public-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] ${className ?? ''}`} aria-label="分享文章">{copied ? '已复制' : '分享'}</button>
}

export default function PublicOriginalLink({ href, articleId, shareUrl, className }: Props) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleClick = () => {
    void fetch(`/api/public/articles/${articleId}/click`, {
      method: 'POST',
      keepalive: true,
    })
  }

  const handleCopy = async () => {
    const url = shareUrl ?? window.location.href
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  useEffect(() => {
    if (!open) return

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className={`relative shrink-0 ${className ?? ''}`}>
      <button
        type="button"
        aria-label="打开原文"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="打开原文"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-7 w-7 items-center justify-center rounded-none text-[var(--public-muted-soft)] transition-colors hover:bg-[var(--public-surface-soft)] hover:text-[var(--public-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--public-canvas)]"
      >
        <ExternalLink aria-hidden="true" className="h-4 w-4" strokeWidth={1.5} />
      </button>

      {open && (
        <div role="dialog" aria-label="打开原文确认" className="absolute right-0 top-full z-50 mt-2 w-64 border border-[var(--public-hairline-strong)] bg-[var(--public-surface)] px-4 py-3 text-left shadow-[0_12px_30px_rgb(20_20_19_/_0.12)]">
          <p className="text-sm font-medium text-[var(--public-ink)]">打开原文？</p>
          <p className="mt-1 text-xs leading-5 text-[var(--public-muted)]">将前往来源网站继续阅读。</p>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => void handleCopy()} className="inline-flex h-8 items-center gap-1 px-2 text-xs text-[var(--public-muted)] transition-colors hover:text-[var(--public-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]" title="复制文章链接">{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? '已复制' : '复制链接'}</button>
            <button type="button" onClick={() => setOpen(false)} className="h-8 px-3 text-xs text-[var(--public-muted)] transition-colors hover:text-[var(--public-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]">
              取消
            </button>
            <a href={href} target="_blank" rel="noreferrer" onClick={() => { handleClick(); setOpen(false) }} className="inline-flex h-8 items-center bg-[var(--public-primary)] px-3 text-xs text-white transition-colors hover:bg-[var(--public-primary-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--public-surface)]">
              继续打开
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
