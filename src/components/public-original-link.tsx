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
    <a href={href} target="_blank" rel="noreferrer" onClick={handleClick} className="text-sm font-medium text-primary hover:underline">
      查看原文 ↗
    </a>
  )
}
