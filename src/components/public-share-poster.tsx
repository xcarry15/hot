'use client'

import { useEffect, useState } from 'react'
import { Check, Copy, Download, LoaderCircle, Share2 } from 'lucide-react'
import QRCode from 'qrcode'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

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
  const [copied, setCopied] = useState(false)
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
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch { setCopied(false) }
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
      URL.revokeObjectURL(url)
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
      <DialogContent className="public-site max-h-[94dvh] max-w-[640px] overflow-y-auto rounded-none border border-[#d8c9ba] bg-[#e7ddd2] p-0 text-[#302a25] shadow-[0_30px_100px_rgb(63_47_35_/_0.3)] [&_[data-slot=dialog-close]]:text-[#6e6259]">
        <DialogHeader className="flex-row items-center gap-3 border-b border-[#d2c2b3] bg-[#eee6dd] px-6 py-3 pr-14 text-left">
          <DialogTitle className="public-display shrink-0 text-base text-[#302a25]">分享文章</DialogTitle>
          <DialogDescription className="border-l border-[#cdbdaf] pl-3 text-[11px] text-[#776b61]">扫码阅读或分享给朋友</DialogDescription>
        </DialogHeader>
        <div className="px-5 py-6 sm:px-8">
          <article className="mx-auto flex aspect-[45/56] max-w-[390px] flex-col border-t-[6px] border-[#cc785c] bg-[#f3eee6] p-6 text-[#141413] shadow-[0_24px_70px_rgb(0_0_0_/_0.38)] sm:p-7">
            <div className="flex items-start justify-between gap-4 border-b border-[#d6cfc4] pb-4">
              <div>
                <p className="public-display text-base font-bold">行业新闻聚合</p>
              </div>
              <time className="shrink-0 pt-0.5 text-[10px] font-medium text-[#8e8b82]">{publishedAt}</time>
            </div>

            <div className="min-h-0 flex-1 pt-6">
              <h2 className="public-display line-clamp-4 text-[23px] font-bold leading-[1.42]">{title}</h2>
              <p className="mt-5 line-clamp-6 text-[13px] leading-6 text-[#4f4d48]">{summary || '扫码查看文章详情与 AI 洞察。'}</p>
            </div>

            <div className="flex items-center gap-5 border-t border-[#e6dfd8] pt-5">
              <div className="flex h-[74px] w-[74px] shrink-0 items-center justify-center bg-white">
                {qrUrl ? <img src={qrUrl} alt="文章二维码" className="h-full w-full" /> : <span className="text-[9px] text-[#8e8b82]">{error ? '加载失败' : '加载中'}</span>}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold">扫码阅读完整文章</p>
                <p className="mt-1.5 text-[10px] leading-4 text-[#8e8b82]">行业动态 · 品牌资讯 · AI 洞察</p>
                <p className="text-[10px] leading-4 text-[#8e8b82]">hot.kfxz.cn</p>
              </div>
            </div>
          </article>

          <p className="mt-4 text-center text-xs text-[#776b61]">保存图片、扫描二维码或复制链接即可转发</p>
          <div className="mx-auto mt-5 grid max-w-[390px] grid-cols-3 gap-2">
            <button type="button" disabled={saving || !qrUrl} onClick={() => void savePoster()} className="public-pressable inline-flex h-11 items-center justify-center gap-1.5 bg-[var(--public-primary)] px-2 text-sm font-medium text-white transition-colors hover:bg-[var(--public-primary-active)] disabled:opacity-40">{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}{saving ? '保存中' : '保存图片'}</button>
            <button type="button" onClick={() => void copyLink()} className="public-pressable inline-flex h-11 items-center justify-center gap-1.5 border border-[#cbbbaf] bg-[#f5efe8] px-2 text-sm font-medium text-[#51473f] transition-colors hover:bg-[#fffaf4]">{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? '已复制' : '复制链接'}</button>
            <button type="button" onClick={() => void systemShare()} className="public-pressable inline-flex h-11 items-center justify-center gap-1.5 bg-[#40372f] px-2 text-sm font-medium text-white transition-colors hover:bg-[#55483e]"><Share2 className="h-4 w-4" />分享</button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
