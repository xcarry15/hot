'use client'

interface Props {
  href: string
  articleId: string
}

export default function PublicOriginalLink({ href, articleId }: Props) {
  const handleClick = () => {
    void fetch(`/api/public/articles/${articleId}/click`, {
      method: 'POST',
      keepalive: true,
    })
  }

  return (
    <a href={href} target="_blank" rel="noreferrer" onClick={handleClick} className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--public-canvas)]">
      查看原文 ↗
    </a>
  )
}
