import Link from 'next/link'
import PublicMessagePage from '@/components/public-message-page'

export default function PublicArticleNotFound() {
  return (
    <PublicMessagePage
      eyebrow="404"
      title="文章不存在"
      description="这篇文章可能已经下线，或者当前不满足公开条件。"
      actions={<Link href="/" className="public-pressable inline-flex h-10 items-center bg-[var(--public-primary-strong)] px-4 text-sm font-medium text-white transition-colors hover:bg-[var(--public-primary-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary-strong)]">返回文章列表</Link>}
    />
  )
}
