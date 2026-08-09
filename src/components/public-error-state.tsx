'use client'

import Link from 'next/link'
import { RefreshCw } from 'lucide-react'
import PublicMessagePage from '@/components/public-message-page'

interface Props {
  detail?: boolean
}

export default function PublicErrorState({ detail = false }: Props) {
  return (
    <PublicMessagePage
      eyebrow="暂时无法加载"
      title={detail ? '文章暂时不可用' : '文章列表暂时不可用'}
      description="请稍后重试，或返回文章列表继续浏览。"
      actions={(
        <>
          <button type="button" onClick={() => window.location.reload()} className="public-pressable inline-flex h-10 items-center gap-1.5 border border-[var(--public-hairline-strong)] px-4 text-sm font-medium text-[var(--public-ink)] transition-colors hover:border-[var(--public-primary)] hover:text-[var(--public-primary)]">
            <RefreshCw className="h-3.5 w-3.5" />重试
          </button>
          <Link href="/" className="public-pressable inline-flex h-10 items-center bg-[var(--public-primary)] px-4 text-sm font-medium text-white transition-colors hover:bg-[var(--public-primary-active)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color:rgb(204_120_92_/_0.25)]">返回文章列表</Link>
        </>
      )}
    />
  )
}
