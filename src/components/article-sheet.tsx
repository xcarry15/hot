'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ExternalLink,
  Tag,
  AlertTriangle,
  CheckCircle2,
  Clock,
  SkipForward,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatRelativeTime } from '@/lib/shared/date'
import { parseJsonArray, parseTags, stripHtml, splitBrands } from '@/lib/shared/article-codecs'
import { getTagToneClass } from '@/features/article-tag-style'
import { ScoreBadge } from '@/components/ui/score-badge'
import { getScoreStyle } from '@/lib/shared/score-style'
import type { ArticleDetailDto } from '@/contracts/articles'
import {
  fetchArticleDetail as fetchArticleDetailFromClient,
  fetchRelatedByBrand as fetchRelatedByBrandFromClient,
} from '@/features/articles-api.client'
import { isRequestAborted, isRequestJsonError } from '@/lib/request-json.client'

interface Props {
  articleId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectArticle?: (id: string) => void
}

interface RelatedItem {
  id: string
  title: string
  score: number
  createdAt: string
  publishedAt: string | null
  aiStatus: string
  brand: string
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'done':
      return <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 text-xs rounded-full gap-1"><CheckCircle2 className="h-3 w-3" />完成</Badge>
    case 'pending':
      return <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100 text-xs rounded-full gap-1"><Clock className="h-3 w-3" />待处理</Badge>
    case 'failed':
      return <Badge className="bg-orange-100 text-orange-700 hover:bg-orange-100 text-xs rounded-full gap-1"><AlertTriangle className="h-3 w-3" />失败</Badge>
    case 'skipped':
      return <Badge className="bg-slate-100 text-slate-600 hover:bg-slate-100 text-xs rounded-full gap-1"><SkipForward className="h-3 w-3" />跳过</Badge>
    default:
      return <Badge variant="secondary" className="text-xs rounded-full">{status}</Badge>
  }
}

/** 阅读区小节标题：左侧标签 + 右侧贯穿分割线 */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground shrink-0">
        {children}
      </span>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  )
}

export default function ArticleSheet({ articleId, open, onOpenChange, onSelectArticle }: Props) {
  const [article, setArticle] = useState<ArticleDetailDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [relatedItems, setRelatedItems] = useState<RelatedItem[]>([])
  const [relatedLoading, setRelatedLoading] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!articleId || !open) {
      setArticle(null)
      return
    }
    const controller = new AbortController()
    abortControllerRef.current = controller
    setLoading(true)
    setArticle(null)
    fetchArticleDetailFromClient(articleId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setArticle(data)
      })
      .catch((err) => {
        if (isRequestAborted(err) || isRequestJsonError(err, 404)) return
        toast.error('获取文章详情失败')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => {
      controller.abort()
      if (abortControllerRef.current === controller) abortControllerRef.current = null
    }
  }, [articleId, open])

  useEffect(() => {
    const currentId = article?.id
    const currentBrand = article?.brand
    if (!open || !currentId || !currentBrand) {
      setRelatedItems([])
      setRelatedLoading(false)
      return
    }
    const controller = new AbortController()
    setRelatedLoading(true)
    fetchRelatedByBrandFromClient(currentId, 5, controller.signal)
      .then((data: unknown) => {
        if (!controller.signal.aborted) {
          const items = (data as { items?: unknown[] })?.items;
          setRelatedItems(Array.isArray(items) ? (items as RelatedItem[]) : []);
        }
      })
      .catch((err) => {
        if (isRequestAborted(err) || isRequestJsonError(err, 404)) return
        console.error('[related-by-brand] fetch failed:', err)
        setRelatedItems([])
      })
      .finally(() => {
        if (!controller.signal.aborted) setRelatedLoading(false)
      })
    return () => controller.abort()
  }, [article?.id, article?.brand, open])

  const tagItems = article ? parseTags(article.tags) : []
  const keyPoints = article ? parseJsonArray(article.keyPoints) : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-sm:inset-y-0 max-sm:h-full max-sm:rounded-none max-sm:max-w-none sm:max-w-4xl">
        <DialogHeader className="p-5 pb-3 border-b">
          <DialogTitle className="text-base font-semibold tracking-tight">文章详情</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="p-5 space-y-4">
            <Skeleton className="h-7 w-3/4" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : article ? (
          <div className="flex flex-col sm:flex-row gap-0 sm:gap-0 h-[calc(100dvh-180px)] overflow-hidden">
            {/* ======== 左列：侧栏 Meta ======== */}
            <div className="w-full sm:w-[230px] shrink-0 flex flex-col gap-4 p-5 sm:pr-4 sm:py-5 border-b sm:border-b-0 sm:border-r bg-muted/25 overflow-y-auto">
              {/* 评分卡片 */}
              <div className="bg-background rounded-xl border p-4 text-center">
                <div className={`text-4xl font-bold font-mono tabular-nums ${article.score > 0 ? getScoreStyle(article.score).textOnly : 'text-muted-foreground'}`}>
                  {article.score}
                </div>
                <div className="text-xs text-muted-foreground mt-1">综合评分</div>
                {article.score > 0 && (
                  <div className="mt-3 pt-3 border-t space-y-1 text-[10px]">
                    {article.eventScore != null && (
                      <div className="flex justify-between"><span className="text-muted-foreground">事件影响力</span><span className={`font-mono font-medium ${getScoreStyle(article.eventScore).textOnly}`}>{article.eventScore}</span></div>
                    )}
                    {article.contentScore != null && (
                      <div className="flex justify-between"><span className="text-muted-foreground">内容质量</span><span className={`font-mono font-medium ${getScoreStyle(article.contentScore).textOnly}`}>{article.contentScore}</span></div>
                    )}
                    {article.rawScore != null && (
                      <div className="flex justify-between"><span className="text-muted-foreground">加权原始分</span><span className="font-mono font-medium">{article.rawScore}</span></div>
                    )}
                    {article.adProbability != null && (
                      <div className="flex justify-between"><span className="text-muted-foreground">广告概率</span><span className="font-mono font-medium">{article.adProbability}%</span></div>
                    )}
                    {article.aiConfidence != null && (
                      <div className="flex justify-between"><span className="text-muted-foreground">AI 置信度</span><span className="font-mono font-medium">{article.aiConfidence}%</span></div>
                    )}
                  </div>
                )}
              </div>

              {/* 元信息卡片 */}
              <div className="bg-background rounded-xl border p-4 space-y-3 text-sm">
                <StatusBadge status={article.aiStatus} />
                <Badge variant="outline" className="text-xs">{({ unreviewed: '待归类', important: '重要', general: '一般', irrelevant: '无关' } as Record<string, string>)[article.reviewStatus] ?? article.reviewStatus}</Badge>

                {article.isAd && (
                  <Badge className="bg-red-100 text-red-700 hover:bg-red-100 text-xs rounded-full gap-1"><AlertTriangle className="h-3 w-3" />软文</Badge>
                )}
                {article.skipReason?.startsWith('[重复]') && (
                  <Badge className="bg-red-100 text-red-700 hover:bg-red-100 text-xs rounded-full gap-1"><AlertTriangle className="h-3 w-3" />重复</Badge>
                )}

                {article.category && (
                  <div><span className="text-muted-foreground text-xs">分类</span><div className="font-medium mt-0.5">{article.category}</div></div>
                )}
                {article.brand && (
                  <div>
                    <span className="text-muted-foreground text-xs">品牌</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {splitBrands(article.brand).map((b, i) => (
                        <Badge key={i} variant="outline" className="text-xs rounded-none bg-black text-white border-black">{b.trim()}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                <div><span className="text-muted-foreground text-xs">相关度</span><div className="font-medium mt-0.5">{article.relevance}%</div></div>

                {article.pushUrgency === 'urgent' && (
                  <Badge className="bg-red-100 text-red-600 hover:bg-red-100 text-xs rounded-full">紧急</Badge>
                )}
              </div>

              {/* 标签卡片 */}
              {tagItems.length > 0 && (
                <div className="bg-background rounded-xl border p-4">
                  <div className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
                    <Tag className="h-3 w-3" />标签
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {tagItems.map((tag, i) => (
                      <Badge key={i} variant="outline" className={`text-xs rounded-full px-2 py-0.5 ${getTagToneClass(tag.tone) || 'bg-secondary text-secondary-foreground'}`}>{tag.name}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* 相关动态 */}
              {article.brand && (
                <div className="bg-background rounded-xl border p-4">
                  <div className="text-xs font-semibold mb-2">相关动态</div>
                  {relatedLoading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-4 w-full" />
                      ))}
                    </div>
                  ) : relatedItems.length === 0 ? (
                    <p className="text-xs text-muted-foreground">近期暂无其他动态</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {relatedItems.map((r) => (
                        <li key={r.id}>
                          <button
                            type="button"
                            onClick={() => onSelectArticle?.(r.id)}
                            disabled={!onSelectArticle}
                            className="w-full text-left flex items-center gap-1.5 text-xs hover:text-violet-600 transition-colors group disabled:cursor-default"
                          >
                            <ScoreBadge score={r.score} variant="compact" />
                            <span className="truncate flex-1 min-w-0 group-hover:text-violet-600">{r.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {/* ======== 右列：阅读区 ======== */}
            <ScrollArea className="flex-1 min-w-0">
              <div className="p-5 sm:pl-6 sm:pr-7 space-y-6">
                {/* 标题 */}
                <div>
                  <h3 className="font-bold text-lg leading-snug tracking-tight text-foreground">
                    {article.pushUrgency === 'urgent' && <span className="text-red-500 mr-1">🚨</span>}
                    {article.title}
                  </h3>
                </div>

                {/* 来源行 */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span>来源: {article.originalSource ?? article.source?.name ?? '未知来源'}</span>
                  <span>相关度: {article.relevance}%</span>
                  <span>{formatRelativeTime(article.createdAt || '')}</span>
                  <span>浏览 {article.viewCount} · 原文点击 {article.originalClickCount} · 点击率 {article.viewCount > 0 ? Math.round(article.originalClickCount / article.viewCount * 100) : 0}%</span>
                  {article.url && (
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-violet-600 hover:text-violet-700 hover:underline transition-colors"
                    >
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      查看原文
                    </a>
                  )}
                  {article.pushedAt && (
                    <span className="text-emerald-600 inline-flex items-center gap-1">
                      已推送
                      {article.pushLogs && article.pushLogs.length > 0 && (
                        <span className="text-muted-foreground">
                          · {formatRelativeTime(article.pushLogs[0].createdAt)}
                        </span>
                      )}
                    </span>
                  )}
                </div>

                {/* 要点 */}
                {keyPoints.length > 0 && (
                  <div>
                    <SectionLabel>要点</SectionLabel>
                    <ul className="mt-3 space-y-2.5">
                      {keyPoints.map((point, i) => (
                        <li key={i} className="text-sm flex gap-3 items-start group">
                          <span className="w-5 h-5 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5 group-hover:bg-violet-200 transition-colors">
                            {i + 1}
                          </span>
                          <span className="text-foreground/85 leading-relaxed">{point}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* AI 洞察 */}
                {article.summary && (
                  <div>
                    <SectionLabel>洞察</SectionLabel>
                    <div className="mt-3 border-l-[3px] border-violet-400 bg-violet-50/40 rounded-r-lg p-4">
                      <p className="text-sm leading-relaxed text-foreground/80">{article.summary}</p>
                    </div>
                  </div>
                )}

                {/* 正文预览 */}
                {article.cleanContent ? (
                  <div>
                    <SectionLabel>正文预览</SectionLabel>
                    <div className="mt-3 text-sm text-muted-foreground leading-relaxed bg-muted/30 rounded-lg p-4 max-h-56 overflow-y-auto whitespace-pre-line">
                      {stripHtml(article.cleanContent).slice(0, 1000)}
                      {article.cleanContent.length > 1000 && (
                        <span className="text-muted-foreground/50">…</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 p-3 bg-amber-50 rounded-lg">
                    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                    <span className="text-sm text-amber-700">正文抓取失败</span>
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        ) : (
          <div className="p-5 text-sm text-muted-foreground">未找到文章</div>
        )}
      </DialogContent>
    </Dialog>
  )
}
