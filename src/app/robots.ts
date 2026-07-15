import type { MetadataRoute } from 'next'
import { getPublicSiteUrl } from '@/lib/public-site'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/admin', '/api/'] }],
    sitemap: new URL('/sitemap.xml', getPublicSiteUrl()).toString(),
  }
}
