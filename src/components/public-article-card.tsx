import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { parseTags, splitBrands } from '@/lib/shared/article-codecs'
import { getTagToneClass } from '@/features/article-tag-style'
import { ScoreBadge } from '@/components/ui/score-badge'
import type { PublicArticleListItemDto } from '@/contracts/public-articles'

function formatDateTime(value: string | null, fallback: string): string {
  const date = new Date(value || fallback)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(date)
}

export default function PublicArticleCard({ article }: { article: PublicArticleListItemDto }) {
  const tags = parseTags(article.tags)
  const brands = splitBrands(article.brand)

  return (
    <Link href={`/news/${article.id}`} className="group block h-full">
      <Card className="h-full bg-background py-0 rounded-md transition-shadow hover:shadow-md">
        <CardContent className="p-4 flex h-full flex-col gap-2">
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <div className="flex min-w-0 items-center gap-2 truncate">
              <span className="font-mono shrink-0">{formatDateTime(article.publishedAt, article.createdAt)}</span>
              <span className="text-border">|</span>
              <span className="truncate">数据源：{article.source.name}</span>
              {article.originalSource && article.originalSource !== article.source.name && (
                <><span className="text-border">|</span><span className="truncate">原始：{article.originalSource}</span></>
              )}
              {article.category && <><span className="text-border">|</span><span className="shrink-0">{article.category}</span></>}
            </div>
            <ScoreBadge score={article.score} />
          </div>

          <h2 className="text-base font-semibold leading-snug line-clamp-2 group-hover:text-primary transition-colors">
            {article.title}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground line-clamp-3">
            {article.excerpt || '暂无摘要'}
          </p>

          <div className="mt-auto flex flex-wrap gap-1 pt-1">
            {brands.slice(0, 3).map((brand, index) => (
              <Badge key={`${brand}-${index}`} variant="outline" className="rounded-none border-black bg-black px-1.5 py-0 text-xs font-medium text-white">
                {brand.trim()}
              </Badge>
            ))}
            {tags.slice(0, 4).map((tag, index) => (
              <Badge key={`${tag.name}-${index}`} variant="outline" className={`px-1.5 py-0 text-xs font-semibold ${getTagToneClass(tag.tone)}`}>
                {tag.name}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}
