'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ExternalLink,
  Send,
  RefreshCw,
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
import { DISCARD_REASON_LABELS } from '@/components/crawl-log/helpers'
import { ScoreBadge, ScoreBreakdown } from '@/components/ui/score-badge'
import { parseDedupEvidence, type DedupEvidence } from '@/lib/dedup-evidence'
import type { ArticleDetailDto } from '@/contracts/articles'
import {
  fetchArticleDetail as fetchArticleDetailFromClient,
  fetchRelatedByBrand as fetchRelatedByBrandFromClient,
} from '@/features/articles-api.client'
import { fetchDiscardedItem } from '@/features/discarded-api.client'

interface DiscardedDetail {
  id: string
  sourceId: string
  title: string
  url: string
  reason: string
  detail: string
  parsedDetail: Record<string, unknown> | null
  winnerArticleId: string | null
  publishedAt: string | null
  createdAt: string
  source?: { name: string; type: string; url?: string }
}

interface Props {
  articleId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onArticleUpdated?: () => void
  /** 点击「同品牌近 30 天动态」列表项时由父组件提供切到新文章的实现 */
  onSelectArticle?: (id: string) => void
  /** 详情类型：已入库文章 vs 未入库 discarded 项。默认 'article' */
  kind?: 'article' | 'discarded'
  /** 触发 step 动作时通知父组件（如在详情页操作时同步更新抓取记录列表的按钮状态）。
   *  返回 Promise<boolean> — true 表示操作已成功接受，详情抽屉据此刷新文章数据。 */
  onStepAction?: (articleId: string, step: 'process' | 'ai' | 'push', options?: { force?: boolean }) => Promise<boolean>
  /** 批量 Job 运行时禁止单篇动作，和列表行保持同一并发边界。 */
  isJobRunning?: boolean
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

/**
 * 统一去重证据面板 — article（dedupDetail）与 discarded（detail JSON）共用。
 * 目的：让用户复核"是否真的重复"。展示去重方式 / 重复文章+URL / 详情 / 共享数值
 * / 两篇文章里具体重复的片段（高亮，前后各约 20 字上下文）。
 */
function HighlightedContext({ before, shared, after }: { before: string; shared: string; after: string }) {
  return (
    <span className="break-all">
      {before ? <span className="text-muted-foreground/50">{before}</span> : null}
      <mark className="bg-yellow-200 dark:bg-yellow-500/30 text-foreground rounded px-0.5 font-medium">{shared}</mark>
      {after ? <span className="text-muted-foreground/50">{after}</span> : null}
    </span>
  )
}

function DedupEvidencePanel({
  evidence,
  onSelectArticle,
}: {
  evidence: DedupEvidence
  onSelectArticle?: (id: string) => void
}) {
  const matchedId = evidence.matchedId
  return (
    <div className="text-xs bg-red-50/60 dark:bg-red-950/20 border border-red-200/70 dark:border-red-900/40 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-red-700 dark:text-red-400 font-medium">
        <AlertTriangle className="h-3.5 w-3.5" />
        判定为重复文章
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 items-start">
        <span className="text-muted-foreground">去重方式</span>
        <span className="font-medium">{evidence.method}</span>

        <span className="text-muted-foreground">重复文章</span>
        <span className="flex items-center gap-2 flex-wrap">
          <span className="font-medium break-all">{evidence.matchedTitle}</span>
          {matchedId && onSelectArticle && (
            <button
              type="button"
              onClick={() => onSelectArticle(matchedId)}
              className="text-blue-600 hover:underline shrink-0"
              title="在详情面板中打开重复文章"
            >
              查看 ›
            </button>
          )}
        </span>

        <span className="text-muted-foreground">重复 URL</span>
        {evidence.matchedUrl ? (
          <a
            href={evidence.matchedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline font-mono break-all inline-flex items-center gap-1"
            title="在新标签页打开重复文章原文"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            {evidence.matchedUrl}
          </a>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}

        {typeof evidence.similarity === 'number' && (
          <>
            <span className="text-muted-foreground">相似度</span>
            <span className="font-medium tabular-nums">{evidence.similarity.toFixed(2)}</span>
          </>
        )}

        <span className="text-muted-foreground">去重详情</span>
        <span className="break-all">{evidence.detail}</span>

        {evidence.sharedValues && evidence.sharedValues.length > 0 && (
          <>
            <span className="text-muted-foreground">共享数值</span>
            <span className="flex flex-wrap gap-1">
              {evidence.sharedValues.map((v, i) => (
                <Badge key={i} variant="outline" className="text-xs rounded-full">{v}</Badge>
              ))}
            </span>
          </>
        )}
      </div>

      {evidence.snippets && evidence.snippets.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="text-muted-foreground font-medium">内容对比（高亮为重复片段，前后各约 20 字）</div>
          {evidence.snippets.map((s, i) => (
            <div key={i} className="space-y-1 rounded-md bg-background/70 p-2 border border-red-100 dark:border-red-900/30">
              {s.label ? <div className="text-muted-foreground/70">{s.label}</div> : null}
              <div className="leading-relaxed">
                <span className="text-muted-foreground/60 mr-1 shrink-0">本篇</span>
                <HighlightedContext before={s.currentBefore} shared={s.currentShared} after={s.currentAfter} />
              </div>
              <div className="leading-relaxed">
                <span className="text-muted-foreground/60 mr-1 shrink-0">重复</span>
                <HighlightedContext before={s.matchedBefore} shared={s.matchedShared} after={s.matchedAfter} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ArticleDetailSheet({ articleId, open, onOpenChange, onArticleUpdated, onSelectArticle, kind = 'article', onStepAction, isJobRunning = false }: Props) {
  const [article, setArticle] = useState<ArticleDetailDto | null>(null)
  const [discarded, setDiscarded] = useState<DiscardedDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [reprocessing, setReprocessing] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [refetching, setRefetching] = useState(false)
  // 同品牌近 30 天动态（独立 effect，与主 fetch 解耦）
  const [relatedItems, setRelatedItems] = useState<RelatedItem[]>([])
  const [relatedLoading, setRelatedLoading] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
    }
  }, [])

  const fetchArticleDetail = async (): Promise<ArticleDetailDto | null> => {
    if (!articleId) return null
    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    try {
      return await fetchArticleDetailFromClient(articleId, controller.signal)
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null
      }
    }
  }

  useEffect(() => {
    if (!articleId || !open) {
      setArticle(null)
      setDiscarded(null)
      return
    }
    const controller = new AbortController()
    abortControllerRef.current = controller
    setLoading(true)
    setArticle(null)
    setDiscarded(null)
    if (kind === 'discarded') {
      fetchDiscardedItem(articleId, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setDiscarded(data)
        })
        .catch((err) => {
          if (err?.name === 'AbortError' || err instanceof DOMException) return
          toast.error('获取文章详情失败')
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    } else {
      fetchArticleDetailFromClient(articleId, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setArticle(data)
        })
        .catch((err) => {
          if (err?.name === 'AbortError' || err instanceof DOMException) return
          toast.error('获取文章详情失败')
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }
    return () => {
      controller.abort()
      if (abortControllerRef.current === controller) abortControllerRef.current = null
    }
  }, [articleId, open, kind])

  // 切换文章时重置操作状态，避免上一篇文章的 loading 残留在新文章按钮上
  useEffect(() => {
    setReprocessing(false)
    setPushing(false)
    setRefetching(false)
  }, [articleId])

  // 同品牌近 30 天动态：独立 effect，与主 fetch 解耦
  // 依赖 [article?.id, article?.brand]：reprocess / refetch / push 后 article 更新时也会重拉
  // discarded 模式无 brand，跳过
  useEffect(() => {
    if (kind === 'discarded') {
      setRelatedItems([])
      return
    }
    const currentId = article?.id
    const currentBrand = article?.brand
    if (!currentId || !currentBrand) {
      setRelatedItems([])
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
        if (err?.name === 'AbortError' || err instanceof DOMException) return
        console.error('[related-by-brand] fetch failed:', err)
        setRelatedItems([])
      })
      .finally(() => {
        if (!controller.signal.aborted) setRelatedLoading(false)
      })
    return () => controller.abort()
  }, [article?.id, article?.brand, kind])

  const handleReprocess = async () => {
    if (!articleId || !onStepAction) return
    setReprocessing(true)
    try {
      const ok = await onStepAction(articleId, 'ai')
      if (ok) {
        const data = await fetchArticleDetail()
        if (data) setArticle(data)
      }
    } finally {
      setReprocessing(false)
    }
  }

  const handleRefetch = async () => {
    if (!articleId || !onStepAction) return
    setRefetching(true)
    try {
      const ok = await onStepAction(articleId, 'process')
      if (ok) {
        onArticleUpdated?.()
        const data = await fetchArticleDetail()
        if (data) setArticle(data)
      }
    } finally {
      setRefetching(false)
    }
  }

  const handlePush = async () => {
    if (!articleId || !onStepAction) return
    setPushing(true)
    try {
       const ok = await onStepAction(articleId, 'push', { force: article?.pushedAt ? true : undefined })
      if (ok) {
        onArticleUpdated?.()
        const data = await fetchArticleDetail()
        if (data) setArticle(data)
      }
    } finally {
      setPushing(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full p-0 sm:max-w-lg max-sm:inset-y-0 max-sm:h-full max-sm:rounded-none">
        <SheetHeader className="p-5 pb-3 border-b">
          <SheetTitle className="text-base font-semibold tracking-tight">文章后台</SheetTitle>
          <SheetDescription className="sr-only">查看文章AI分析详情</SheetDescription>
        </SheetHeader>
        <ScrollArea className="h-[calc(100dvh-68px)]">
          {loading ? (
            <div className="p-5 space-y-4">
              <Skeleton className="h-7 w-3/4" />
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : article || discarded ? (
            <div className="p-5 pt-0 space-y-4">
              {/* Title & Link */}
              <div>
                <h3 className="font-semibold text-base leading-snug tracking-tight">
                  {article?.pushUrgency === 'urgent' && <span className="text-red-500 mr-1">🚨</span>}
                  {article?.title ?? discarded?.title}
                </h3>
              </div>

              {/* Meta row */}
              {article && (
                <div className="flex flex-wrap items-center gap-2">
                  <ScoreBadge score={article.score} variant="badge" />
                  <StatusBadge status={article.aiStatus} />
                  {article.isAd && (
                    <Badge className="bg-red-100 text-red-700 hover:bg-red-100 text-xs rounded-full gap-1"><AlertTriangle className="h-3 w-3" />软文</Badge>
                  )}
                  {article.skipReason?.startsWith('[重复]') && (
                    <Badge className="bg-red-100 text-red-700 hover:bg-red-100 text-xs rounded-full gap-1"><AlertTriangle className="h-3 w-3" />重复</Badge>
                  )}
                  {article.category && <Badge variant="outline" className="text-xs rounded-full">{article.category}</Badge>}
                  {article.brand && splitBrands(article.brand).map((b, i) => (
                    <Badge key={i} variant="outline" className="text-xs rounded-none bg-black text-white border-black">{b.trim()}</Badge>
                  ))}
                </div>
              )}
              {discarded && (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100 text-xs rounded-full">
                    未入库：{DISCARD_REASON_LABELS[discarded.reason] || discarded.reason}
                  </Badge>
                </div>
              )}

              {/* 评分构成 */}
              {article && article.score > 0 && (
                <ScoreBreakdown
                  score={article.score}
                  eventScore={article.eventScore}
                  contentScore={article.contentScore}
                  rawScore={article.rawScore}
                  adProbability={article.adProbability}
                  aiConfidence={article.aiConfidence}
                />
              )}

              {/* Source & Time */}
              <div className="flex flex-wrap gap-x-4 text-sm text-muted-foreground">
                <span>来源: {article?.originalSource ?? article?.source?.name ?? discarded?.source?.name ?? '未知来源'}</span>
                {article && <span>相关度: {article.relevance}%</span>}
                <span>{article ? '创建' : '丢弃'}：{formatRelativeTime((article?.createdAt ?? discarded?.createdAt) || '')}</span>
                {article?.pushedAt && (
                  <span className="text-emerald-600 inline-flex items-center gap-1">
                    已推送
                    {/* 最新一条推送记录时间：紧跟"已推送"状态，作为时间补充信息 */}
                    {article.pushLogs && article.pushLogs.length > 0 && (
                      <span className="text-muted-foreground">
                        · {formatRelativeTime(article.pushLogs[0].createdAt)}
                      </span>
                    )}
                  </span>
                )}
                {article?.pushUrgency === 'urgent' && <span className="text-red-500 font-medium">紧急</span>}
              </div>

              {/* Tags — article only */}
              {article && (() => {
                const tagItems = parseTags(article.tags);
                if (tagItems.length === 0) return null;
                return (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Tag className="h-4 w-4 text-muted-foreground" />
                    {tagItems.map((tag, i) => (
                      <Badge key={i} variant="outline" className={`text-xs rounded-full px-2 py-0.5 ${getTagToneClass(tag.tone) || 'bg-secondary text-secondary-foreground'}`}>{tag.name}</Badge>
                    ))}
                  </div>
                );
              })()}

              {/* Discarded 去重证据（canonical → 统一面板；旧/非去重 → 通用字段） */}
              {discarded && (() => {
                const ev = parseDedupEvidence(discarded.detail)
                if (ev) {
                  const evidence = ev.matchedId ? ev : { ...ev, matchedId: discarded.winnerArticleId ?? undefined }
                  return <DedupEvidencePanel evidence={evidence} onSelectArticle={onSelectArticle} />
                }
                // 非去重（filter:*）或旧格式 discarded：保留通用元数据展示
                if (!discarded.parsedDetail) return null
                return (
                  <div className="text-xs bg-muted/40 rounded-lg p-3 space-y-1">
                    {typeof discarded.parsedDetail.method === 'string' && (
                      <div><span className="text-muted-foreground">去重方式：</span><span className="font-medium">{discarded.parsedDetail.method}</span></div>
                    )}
                    {typeof discarded.parsedDetail.matchedTitle === 'string' && (
                      <div><span className="text-muted-foreground">匹配文章：</span><span className="font-medium">{discarded.parsedDetail.matchedTitle}</span></div>
                    )}
                    {typeof discarded.parsedDetail.matchedUrl === 'string' && (
                      <div><span className="text-muted-foreground">匹配 URL：</span><span className="font-mono break-all">{discarded.parsedDetail.matchedUrl}</span></div>
                    )}
                    {typeof discarded.parsedDetail.similarity === 'number' && (
                      <div><span className="text-muted-foreground">相似度：</span><span className="font-medium">{(discarded.parsedDetail.similarity as number).toFixed(2)}</span></div>
                    )}
                    {typeof discarded.parsedDetail.sample === 'string' && (
                      <div><span className="text-muted-foreground">标题/摘要样本：</span><span className="break-all">{discarded.parsedDetail.sample}</span></div>
                    )}
                    {typeof discarded.parsedDetail.titleLength === 'number' && (
                      <div><span className="text-muted-foreground">标题长度：</span><span className="font-medium">{discarded.parsedDetail.titleLength}</span></div>
                    )}
                    {typeof discarded.parsedDetail.hasDetailContent === 'boolean' && (
                      <div><span className="text-muted-foreground">有详情：</span><span className="font-medium">{discarded.parsedDetail.hasDetailContent ? '是' : '否'}</span></div>
                    )}
                    {typeof discarded.parsedDetail.hasSummary === 'boolean' && (
                      <div><span className="text-muted-foreground">有摘要：</span><span className="font-medium">{discarded.parsedDetail.hasSummary ? '是' : '否'}</span></div>
                    )}
                  </div>
                )
              })()}

              {/* Winner article ID — 仅在未走统一面板时单独展示（canonical 面板已含 matchedId） */}
              {discarded && discarded.winnerArticleId && !parseDedupEvidence(discarded.detail) && (
                <div className="text-xs bg-muted/40 rounded-lg p-3 space-y-1">
                  <div><span className="text-muted-foreground">胜出文章 ID：</span><span className="font-mono">{discarded.winnerArticleId}</span></div>
                </div>
              )}

              {/* Article 去重证据（canonical → 统一面板；旧格式 → 回退到 skipReason 文本） */}
              {article && article.skipReason?.startsWith('[重复]') && (() => {
                const ev = parseDedupEvidence(article.dedupDetail)
                if (ev) return <DedupEvidencePanel evidence={ev} onSelectArticle={onSelectArticle} />
                return (
                  <div className="text-xs bg-muted/40 rounded-lg p-3 space-y-1">
                    <div className="text-muted-foreground font-medium mb-1">去重详情</div>
                    <div><span className="text-red-600">{article.skipReason}</span></div>
                  </div>
                )
              })()}

              <Separator />

              {/* Key Points / AI Summary / Content Preview / Related — article only */}
              {article && (() => {
                const keyPoints = parseJsonArray(article.keyPoints);
                return (
                  <>
                    {/* Key Points */}
                    {keyPoints.length > 0 && (
                      <div>
                        <span className="text-sm font-semibold">要点</span>
                        <ul className="mt-2 space-y-1">
                          {keyPoints.map((point, i) => (
                            <li key={i} className="text-sm text-muted-foreground flex gap-2">
                              <span className="text-foreground shrink-0">›</span>
                              {point}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                  {/* AI Summary */}
                  {article.summary && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm font-semibold">洞察</span>
                      </div>
                      <p className="text-sm text-muted-foreground leading-relaxed bg-muted/50 rounded-lg p-3">
                        {article.summary}
                      </p>
                    </div>
                  )}

                  {/* Content Preview */}
                  {article.cleanContent ? (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm font-semibold">正文预览</span>
                        {(article?.url ?? discarded?.url) && (
                          <a
                            href={article?.url ?? discarded?.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                            title="在新标签页打开原文"
                          >
                            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                            查看原文
                          </a>
                        )}
                      </div>
                      {/* 样式与「洞察」保持一致；line-clamp-6 + max-h-48 + whitespace-pre-line 是正文预览独有的高度/换行约束 */}
                      <p className="text-sm text-muted-foreground leading-relaxed bg-muted/50 rounded-lg p-3 line-clamp-6 max-h-48 overflow-y-auto whitespace-pre-line">
                        {stripHtml(article.cleanContent).slice(0, 500)}
                        {article.cleanContent.length > 500 && '...'}
                      </p>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 p-3 bg-amber-50 rounded-lg">
                      <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                      <span className="text-sm text-amber-700">正文抓取失败</span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 px-3 text-xs ml-auto"
                        disabled={refetching}
                        onClick={handleRefetch}
                      >
                        <RefreshCw className={`h-3.5 w-3.5 mr-1 ${refetching ? 'animate-spin' : ''}`} />
                        重新抓取
                      </Button>
                    </div>
                  )}
                  </>
                );
              })()}

              {/* 同品牌近 30 天动态（最多 5 条）—— 仅在 article 有 brand 时显示 */}
              {article?.brand && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-semibold">相关动态</span>
                    {!relatedLoading && relatedItems.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        ({relatedItems.length})
                      </span>
                    )}
                  </div>
                  {relatedLoading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-5 w-full" />
                      ))}
                    </div>
                  ) : relatedItems.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      近期暂无其他动态
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {relatedItems.map((r) => (
                        <li key={r.id}>
                          <button
                            type="button"
                            onClick={() => onSelectArticle?.(r.id)}
                            disabled={!onSelectArticle}
                            className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-muted/50 transition-colors group disabled:cursor-default disabled:hover:bg-transparent"
                          >
                            <ScoreBadge score={r.score} variant="badge" />
                            <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                              {formatRelativeTime(r.publishedAt ?? r.createdAt)}
                            </span>
                            <span className="text-sm truncate flex-1 min-w-0 group-hover:text-blue-600 transition-colors inline-flex items-center gap-1">
                              <span className="truncate">{r.title}</span>
                              {/* 非品牌主匹配（命中在 title/summary 而非 brand）：提示用户这是上下文提及 */}
                              {!r.brand.includes(splitBrands(article?.brand || '')[0] || '') && (
                                <span
                                  className="text-xs text-muted-foreground shrink-0"
                                  title="该文章 brand 字段不含此品牌，命中于 title/summary"
                                >
                                  [提及]
                                </span>
                              )}
                              {/* failed 文章是 AI 调用失败后的状态，仅供展示 */}
                              {r.aiStatus === 'failed' && (
                                <span
                                  className="text-xs text-orange-600 shrink-0"
                                  title="AI 处理失败，将进入重试池"
                                >
                                  [失败]
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <Separator />

              {/* Actions — article only */}
              {article && (
                <div className="flex flex-wrap gap-2 sm:gap-3">
                  <Button size="default" variant="outline" onClick={handleReprocess} disabled={reprocessing || isJobRunning} className="gap-1.5 flex-1 sm:flex-none">
                    <RefreshCw className={`h-4 w-4 ${reprocessing ? 'animate-spin' : ''}`} />
                    {reprocessing ? '处理中...' : '重新AI处理'}
                  </Button>
                  {!article.pushedAt ? (
                     <Button size="default" onClick={handlePush} disabled={pushing || isJobRunning} className="gap-1.5 flex-1 sm:flex-none">
                      <Send className="h-4 w-4" />
                      {pushing ? '推送中...' : '推送飞书'}
                    </Button>
                  ) : (
                     <Button size="default" variant="outline" onClick={handlePush} disabled={pushing || isJobRunning} className="gap-1.5 flex-1 sm:flex-none">
                      <Send className="h-4 w-4" />
                      {pushing ? '推送中...' : '重新推送飞书'}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="p-5 text-sm text-muted-foreground">未找到文章</div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
