'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Search,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import ArticleSheet from './article-sheet'
import { EmptyState } from '@/components/ui/empty-state'
import { parseTags, splitBrands } from '@/lib/shared/article-codecs'
import { getTagToneClass } from '@/features/article-tag-style'
import { ScoreBadge } from '@/components/ui/score-badge'
import type { ArticleListItemDto, ArticleListResponseDto } from '@/contracts/articles'
import { fetchArticleList } from '@/features/articles-api.client'

function formatDateTime(dateStr: string | null) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  // UTC 午夜（列表页仅有日期）→ 只显示日期，避免误导为 08:00
  if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0) {
    return `${y}-${m}-${d}`
  }
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${d} ${h}:${min}`
}

function excerpt(article: ArticleListItemDto): string {
  return article.excerpt
}

export default function ArticlesTab() {
  const searchParams = useSearchParams()
  const router = useRouter()

  // 从 URL 读取初始值，让浏览器前进/后退可用
  const [data, setData] = useState<ArticleListResponseDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(() => parseInt(searchParams.get('page') || '1'))
  const [search, setSearch] = useState(() => searchParams.get('search') || '')
  const [searchInput, setSearchInput] = useState(() => searchParams.get('search') || '')
  const [categoryFilter, setCategoryFilter] = useState<string>(() => searchParams.get('category') || 'all')
  const [brandFilter, setBrandFilter] = useState<string>(() => searchParams.get('brand') || 'all')
  const [minScore, setMinScore] = useState(() => searchParams.get('minScore') || '')
  const [minRelevance, setMinRelevance] = useState(() => searchParams.get('minRelevance') || '')
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  // 同步筛选状态到 URL（浏览器前进/后退可用）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (page > 1) params.set('page', String(page)); else params.delete('page')
    if (search) params.set('search', search); else params.delete('search')
    if (categoryFilter !== 'all') params.set('category', categoryFilter); else params.delete('category')
    if (brandFilter !== 'all') params.set('brand', brandFilter); else params.delete('brand')
    if (minScore) params.set('minScore', minScore); else params.delete('minScore')
    if (minRelevance) params.set('minRelevance', minRelevance); else params.delete('minRelevance')
    const qs = params.toString()
    const newUrl = window.location.pathname + (qs ? `?${qs}` : '')
    router.replace(newUrl, { scroll: false })
  }, [page, search, categoryFilter, brandFilter, minScore, minRelevance, router])

  const fetchArticles = useCallback(async () => {
    setLoading(true)
    try {
      const json = await fetchArticleList({
        page,
        pageSize: 40,
        search: search || undefined,
        category: categoryFilter !== 'all' ? categoryFilter : undefined,
        brand: brandFilter !== 'all' ? brandFilter : undefined,
        minScore: minScore ? Number(minScore) : undefined,
        minRelevance: minRelevance ? Number(minRelevance) : undefined,
      })
      setData(json)
    } catch (err) {
      toast.error('文章列表加载失败')
      console.error('[articles-tab] fetchArticles failed:', err)
    } finally {
      setLoading(false)
    }
  }, [page, search, categoryFilter, brandFilter, minScore, minRelevance])

  useEffect(() => {
    const handle = setTimeout(fetchArticles, 0)
    return () => clearTimeout(handle)
  }, [fetchArticles])

  const handleSearch = () => {
    if (searchInput !== search) {
      setSearch(searchInput)
      setPage(1)
    }
  }

  const openDetail = (id: string) => {
    setSelectedArticleId(id)
    setDetailOpen(true)
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Filter Bar */}
      <div className="p-3 sm:p-4 border-b space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Input
              placeholder="搜索标题/点评/品牌..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="h-9 text-sm"
            />
            <Button size="sm" variant="outline" onClick={handleSearch} className="h-9 px-3 shrink-0" aria-label="搜索">
              <Search className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={categoryFilter} onValueChange={(v) => { setCategoryFilter(v); setPage(1) }}>
            <SelectTrigger className="h-8 w-[96px] text-xs" aria-label="分类筛选">
              <SelectValue placeholder="分类" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部分类</SelectItem>
              {(data?.facets.categories ?? []).map(({ value, count }) => (
                <SelectItem key={value} value={value}>{value} ({count})</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={brandFilter} onValueChange={(v) => { setBrandFilter(v); setPage(1) }}>
            <SelectTrigger className="h-8 w-[96px] text-xs" aria-label="品牌筛选">
              <SelectValue placeholder="品牌" />
            </SelectTrigger>
            <SelectContent maxHeight="320px">
              <SelectItem value="all">全部品牌</SelectItem>
              {(data?.facets.brands ?? []).map(({ value, count }) => (
                <SelectItem key={value} value={value}>{value} ({count})</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="≥评分"
            type="number"
            min="0"
            max="100"
            value={minScore}
            onChange={(e) => { setMinScore(e.target.value); setPage(1) }}
            className="h-8 w-[72px] text-xs"
          />
          <Input
            placeholder="≥相关"
            type="number"
            min="0"
            max="100"
            value={minRelevance}
            onChange={(e) => { setMinRelevance(e.target.value); setPage(1) }}
            className="h-8 w-[72px] text-xs"
          />
          {data && (
            <span className="text-xs text-muted-foreground ml-auto">共 {data.total} 条</span>
          )}
        </div>
      </div>

      {/* Article Card Grid */}
      <ScrollArea className="flex-1 min-h-0">
        {loading ? (
          <div className="p-3 sm:p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Card key={i} className="bg-background shadow-sm py-0 rounded-md">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-4 w-12" />
                  </div>
                  <Skeleton className="h-5 w-full" />
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-10 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : data && data.items.length > 0 ? (
          <div className="p-3 sm:p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {data.items.map((article) => {
              const tags = parseTags(article.tags)
              const text = excerpt(article)
              const isUrgent = article.pushUrgency === 'urgent'
              const metaTime = formatDateTime(article.publishedAt || article.createdAt)
              return (
                <Card
                  key={article.id}
                  className="bg-background shadow-sm hover:shadow-md transition-shadow cursor-pointer flex flex-col py-0 gap-0 rounded-md"
                  tabIndex={0}
                  role="button"
                  aria-label={article.title}
                  onClick={() => openDetail(article.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      openDetail(article.id)
                    }
                  }}
                >
                  <CardContent className="p-3 flex flex-col gap-1.5 h-full">
                    {/* Meta header */}
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground min-w-0 flex-nowrap">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono shrink-0">{metaTime}</span>
                        {article.source.name && (
                          <>
                            <span className="text-border shrink-0">|</span>
                            <span className="font-medium text-muted-foreground min-w-0 flex-shrink-1 truncate">{article.originalSource || article.source.name}</span>
                          </>
                        )}
                        {article.category && (
                          <>
                            <span className="text-border shrink-0">|</span>
                            <span className="flex-shrink-0">{article.category}</span>
                          </>
                        )}
                      </div>
                      <ScoreBadge score={article.score} />
                    </div>

                    {/* Title */}
                    <h3 className="text-base font-semibold leading-snug flex items-center gap-1 flex-nowrap min-w-0 overflow-hidden">
                      {article.isAd && (
                        <Badge variant="destructive" className="text-xs px-1 py-0 h-4 gap-0.5 shrink-0 rounded-none">
                          软文
                        </Badge>
                      )}
                      {article.skipReason?.startsWith('[重复]') && (
                        <Badge variant="destructive" className="text-xs px-1 py-0 h-4 gap-0.5 shrink-0 rounded-none">
                          重复
                        </Badge>
                      )}
                      {isUrgent && <span className="text-red-500 mr-1 shrink-0">🚨</span>}
                      <span className="truncate">{article.title}</span>
                    </h3>

                    {/* Excerpt */}
                    {text ? (
                      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">
                        {text}
                      </p>
                    ) : (
                      <div className="flex items-center gap-1.5 text-xs text-amber-600">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        <span>暂无摘要</span>
                      </div>
                    )}

                    {/* Footer: tags */}
                    <div className="mt-auto flex items-end justify-between gap-2">
                      <div className="flex flex-wrap gap-0.5 min-w-0 max-h-6 overflow-hidden">
                        {article.brand && splitBrands(article.brand).map((b, i) => (
                          <Badge key={i} variant="outline" className="text-xs px-1 py-0 h-5 font-medium rounded-none bg-black text-white border-black">
                            {b.trim()}
                          </Badge>
                        ))}
                        {tags.slice(0, 5).map((tag, idx) => (
                            <Badge
                              key={idx}
                              variant="outline"
                              className={`text-xs px-1 py-0 h-5 font-semibold ${getTagToneClass(tag.tone)}`}
                            >
                              {tag.name}
                            </Badge>
                          ))}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        ) : (
          <EmptyState
            title="暂无文章数据"
            description="爬取任务完成后，文章会出现在这里"
            className="p-8"
          />
        )}
      </ScrollArea>

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 p-2 border-t">
          <span className="text-xs text-muted-foreground">
            第 {data.page}/{data.totalPages} 页
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            aria-label="上一页"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2"
            disabled={page >= data.totalPages}
            onClick={() => setPage(p => p + 1)}
            aria-label="下一页"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      )}

      {/* Article Detail Sheet */}
      <ArticleSheet
        articleId={selectedArticleId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onArticleUpdated={fetchArticles}
        onSelectArticle={setSelectedArticleId}
      />
    </div>
  )
}
