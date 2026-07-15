import type { MetadataRoute } from 'next'
import { listPublicArticleIds } from '@/lib/public-article-service'
import { getPublicSiteUrl } from '@/lib/public-site'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = getPublicSiteUrl()
  const articles = await listPublicArticleIds()
  return [
    { url: baseUrl.toString(), lastModified: new Date(), changeFrequency: 'hourly', priority: 1 },
    ...articles.map((article) => ({
      url: new URL(`/news/${article.id}`, baseUrl).toString(),
      lastModified: article.updatedAt,
      changeFrequency: 'daily' as const,
      priority: 0.8,
    })),
  ]
}
