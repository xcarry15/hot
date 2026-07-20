'use client'

import dynamic from 'next/dynamic'
import type { ArticleWorkspacePanel } from '@/components/article-workspace'

const loadArticleWorkspace = () => import('@/components/intelligence-inbox')

const IntelligenceInbox = dynamic(loadArticleWorkspace, {
  loading: () => null,
})

export function preloadArticleWorkspace(): void {
  void loadArticleWorkspace()
}

export default function ArticleWorkspaceDrawer({
  articleId,
  panel,
  open,
  onOpenChange,
  onArticleChange,
  onChanged,
}: {
  articleId: string | null
  panel: ArticleWorkspacePanel | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onArticleChange: (articleId: string | null, panel?: ArticleWorkspacePanel | null) => void
  onChanged: () => void
}) {
  if (!open && !articleId) return null

  return (
    <IntelligenceInbox
      articleId={articleId}
      initialPanel={panel}
      open={open}
      onOpenChange={onOpenChange}
      onArticleChange={onArticleChange}
      onChanged={onChanged}
    />
  )
}
