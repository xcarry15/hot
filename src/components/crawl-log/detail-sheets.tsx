"use client"

import type { ArticleWorkspacePanel } from "@/components/article-workspace"
import DiscardedDetailSheet from "../article-detail-sheet"
import ArticleLibrarySheet from "../article-library-sheet"
import ArticleWorkspaceDrawer from "../article-workspace-drawer"

interface CrawlLogDetailSheetsProps {
  discardedDetailId: string | null
  detailOpen: boolean
  onDetailOpenChange: (open: boolean) => void
  libraryOpen: boolean
  libraryView: "all" | "attention" | "cluster_review" | "low_confidence"
  humanQueue: { total: number; clusterReview: number; lowConfidence: number }
  onLibraryOpenChange: (open: boolean) => void
  onOpenArticle: (articleId: string) => void
  articleDetailId: string | null
  articleDetailPanel: ArticleWorkspacePanel | null
  articleDetailOpen: boolean
  onArticleDetailOpenChange: (open: boolean) => void
  onArticleChange: (articleId: string | null, panel?: ArticleWorkspacePanel | null) => void
  onChanged: () => void
}

export function CrawlLogDetailSheets({
  discardedDetailId, detailOpen, onDetailOpenChange, libraryOpen, libraryView, humanQueue,
  onLibraryOpenChange, onOpenArticle, articleDetailId, articleDetailPanel, articleDetailOpen,
  onArticleDetailOpenChange, onArticleChange, onChanged,
}: CrawlLogDetailSheetsProps) {
  return (
    <>
      <DiscardedDetailSheet
        discardedId={discardedDetailId}
        open={detailOpen}
        onOpenChange={onDetailOpenChange}
      />
      <ArticleLibrarySheet
        open={libraryOpen}
        initialView={libraryView}
        counts={humanQueue}
        onOpenChange={onLibraryOpenChange}
        onOpenArticle={onOpenArticle}
      />
      <ArticleWorkspaceDrawer
        articleId={articleDetailId}
        panel={articleDetailPanel}
        open={articleDetailOpen}
        onOpenChange={onArticleDetailOpenChange}
        onArticleChange={onArticleChange}
        onChanged={onChanged}
      />
    </>
  )
}
