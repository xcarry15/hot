'use client'

import { useEffect, useState } from 'react'
import { Download, LoaderCircle, Share2 } from 'lucide-react'
import QRCode from 'qrcode'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PUBLIC_SITE_NAME, PUBLIC_SITE_TAGLINE } from '@/lib/public-brand'

type Props = {
  shareUrl: string
  title: string
  summary: string
  publishedAt: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function PublicSharePoster(props: Props) {
  const { open, publishedAt, shareUrl, summary, title } = props
  const [qrUrl, setQrUrl] = useState('')
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setQrUrl('')
    setError(false)
    void QRCode.toDataURL(shareUrl, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: { dark: '#141413', light: '#ffffff' },
    }).then((dataUrl) => {
      if (!cancelled) setQrUrl(dataUrl)
    }).catch(() => {
      if (!cancelled) setError(true)
    })
    return () => { cancelled = true }
  }, [open, shareUrl])

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
    } catch {}
  }

  const savePoster = async () => {
    try {
      setSaving(true)
      const response = await fetch('/api/public/share-poster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publishedAt, shareUrl, summary, title }),
      })
      if (!response.ok) throw new Error('保存失败')
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.download = `行业新闻海报-${title.slice(0, 20)}.png`
      link.href = url
      link.click()
      // 立即 revoke 在部分浏览器会早于下载任务读取 Blob，导致保存空文件。
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } finally {
      setSaving(false)
    }
  }

  const systemShare = async () => {
    if (!navigator.share) {
      await copyLink()
      return
    }
    try {
      await navigator.share({ title, text: summary, url: shareUrl })
    } catch (shareError) {
      if (shareError instanceof DOMException && shareError.name === 'AbortError') return
      await copyLink()
    }
  }

  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent className="public-site max-h-[94dvh] max-w-[640px] overflow-y-auto rounded-none border border-[var(--public-hairline)] bg-[var(--public-surface)] p-0 text-[var(--public-ink)] shadow-[0_20px_60px_rgb(20_20_19_/_0.2)] [&_[data-slot=dialog-close]]:text-[var(--public-muted)]">
        <DialogHeader className="flex-row items-center gap-3 border-b border-[var(--public-hairline)] px-6 py-3 pr-14 text-left">
          <DialogTitle className="public-display shrink-0 text-base text-[var(--public-ink)]">分享文章</DialogTitle>
        </DialogHeader>
        <div className="px-5 py-6 sm:px-8">
          <article className="mx-auto flex aspect-[45/56] max-w-[390px] flex-col bg-[var(--public-surface)] p-6 text-[var(--public-ink)] shadow-[0_8px_24px_rgb(20_20_19_/_0.12)] sm:p-7">
            <div className="flex items-start justify-between gap-4 border-b border-[var(--public-hairline)] pb-4">
              <div>
                <p className="public-display text-base font-bold">{PUBLIC_SITE_NAME}</p>
              </div>
              <time className="shrink-0 pt-0.5 text-[10px] font-medium text-[var(--public-muted)]">{publishedAt}</time>
            </div>

            <div className="min-h-0 flex-1 pt-6">
              <h2 className="public-display line-clamp-4 text-[26px] font-bold leading-[1.42]">{title}</h2>
              <div className="relative mt-5">
                <div className="absolute top-0 left-0 h-8 w-full bg-gradient-to-b from-[var(--public-surface)] to-transparent" />
                <p className="line-clamp-5 text-[17px] leading-6 text-[var(--public-body)]">{summary || '扫码查看文章详情与 AI 洞察。'}</p>
                <div className="absolute bottom-0 left-0 h-8 w-full bg-gradient-to-t from-[var(--public-surface)] to-transparent" />
              </div>
            </div>

            <div className="flex items-center gap-5 border-t border-[var(--public-hairline)] pt-5">
              <div className="flex h-[74px] w-[74px] shrink-0 items-center justify-center bg-white">
                {qrUrl ? <img src={qrUrl} alt="文章二维码" className="h-full w-full" /> : <span className="text-[9px] text-[var(--public-muted)]">{error ? '加载失败' : '加载中'}</span>}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold">扫码阅读完整文章</p>
                <p className="mt-1.5 text-[10px] leading-4 text-[var(--public-muted)]">{PUBLIC_SITE_TAGLINE}</p>
                <p className="text-[10px] leading-4 text-[var(--public-muted)]">hot.kfxz.cn</p>
              </div>
            </div>
          </article>

          <div className="mx-auto mt-6 grid max-w-[390px] grid-cols-2 gap-3">
            <button type="button" disabled={saving || !qrUrl} onClick={() => void savePoster()} className="public-pressable inline-flex h-11 items-center justify-center gap-1.5 bg-[var(--public-primary)] px-2 text-sm font-medium text-white transition-colors hover:bg-[var(--public-primary-active)] disabled:opacity-40">{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}{saving ? '保存中' : '保存图片'}</button>
            <button type="button" onClick={() => void systemShare()} className="public-pressable inline-flex h-11 items-center justify-center gap-1.5 border border-[var(--public-hairline)] bg-[var(--public-surface-soft)] px-2 text-sm font-medium text-[var(--public-ink)] transition-colors hover:bg-[var(--public-surface)]"><Share2 className="h-4 w-4" />系统分享</button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
