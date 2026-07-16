import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { SETTING_KEYS } from '@/lib/settings-catalog'
import { invalidatePublicArticleCache } from '@/lib/public-article-cache'

const PUBLIC_MIN_SCORE_KEY = SETTING_KEYS.PUBLIC_MIN_SCORE
const PUBLIC_HIDE_ADS_KEY = SETTING_KEYS.PUBLIC_HIDE_ADS

export const PUBLIC_PUBLICATION_STATUS = {
  unpublished: 'unpublished',
  published: 'published',
  revoked: 'revoked',
} as const

export const PUBLIC_PUBLICATION_REBUILD_KEYS: ReadonlySet<string> = new Set([
  PUBLIC_MIN_SCORE_KEY,
  PUBLIC_HIDE_ADS_KEY,
])

export type PublicPublicationDb = Pick<Prisma.TransactionClient, 'article' | 'setting'>

type PublicPublicationConfig = {
  minScore: number
  hideAds: boolean
}

type PublicPublicationCandidate = {
  id: string
  aiStatus: string
  score: number
  isAd: boolean
  publicOverride: string
  publicStatus: string
  publicPublishedAt: Date | null
  publicRevokedAt: Date | null
  publicContentUpdatedAt: Date | null
  source: {
    publicEnabled: boolean
    deletedAt: Date | null
  }
}

async function getPublicPublicationConfig(client: PublicPublicationDb = db): Promise<PublicPublicationConfig> {
  const [minScore, hideAds] = await Promise.all([
    client.setting.findUnique({ where: { key: PUBLIC_MIN_SCORE_KEY }, select: { value: true } }),
    client.setting.findUnique({ where: { key: PUBLIC_HIDE_ADS_KEY }, select: { value: true } }),
  ])
  const parsedMinScore = Number(minScore?.value ?? 70)
  return {
    minScore: Number.isFinite(parsedMinScore) ? Math.min(100, Math.max(0, Math.round(parsedMinScore))) : 70,
    hideAds: hideAds?.value !== 'false',
  }
}

function getRevokeReason(article: PublicPublicationCandidate, config: PublicPublicationConfig): string {
  if (article.aiStatus !== 'done') return 'ai-not-done'
  if (article.source.deletedAt || !article.source.publicEnabled) return 'source-disabled'
  if (article.publicOverride === 'hidden') return 'manual-hidden'
  if (article.publicOverride === 'auto' && article.score < config.minScore) return 'score-below-threshold'
  if (config.hideAds && article.publicOverride !== 'public' && article.isAd) return 'ad-hidden'
  return 'not-publicly-eligible'
}

function isPubliclyEligible(article: PublicPublicationCandidate, config: PublicPublicationConfig): boolean {
  if (article.aiStatus !== 'done') return false
  if (article.source.deletedAt || !article.source.publicEnabled) return false
  if (article.publicOverride !== 'public' && article.publicOverride !== 'auto') return false
  if (article.publicOverride === 'auto' && article.score < config.minScore) return false
  if (config.hideAds && article.publicOverride !== 'public' && article.isAd) return false
  return true
}

async function syncCandidate(
  article: PublicPublicationCandidate,
  config: PublicPublicationConfig,
  client: PublicPublicationDb = db,
  options: { contentChanged?: boolean } = {},
): Promise<void> {
  const now = new Date()
  const published = isPubliclyEligible(article, config)
  const wasPublished = article.publicStatus === PUBLIC_PUBLICATION_STATUS.published
  const wasEverPublished = article.publicStatus === PUBLIC_PUBLICATION_STATUS.published
    || article.publicPublishedAt !== null
  const nextStatus = published
    ? PUBLIC_PUBLICATION_STATUS.published
    : wasEverPublished
      ? PUBLIC_PUBLICATION_STATUS.revoked
      : PUBLIC_PUBLICATION_STATUS.unpublished

  await client.article.update({
    where: { id: article.id },
    data: {
      publicStatus: nextStatus,
      publicPublishedAt: published
        ? article.publicPublishedAt ?? now
        : article.publicPublishedAt,
      publicRevokedAt: published
        ? null
        : nextStatus === PUBLIC_PUBLICATION_STATUS.revoked
          ? wasPublished ? now : article.publicRevokedAt ?? now
          : null,
      publicPublicationReason: published ? 'eligible' : getRevokeReason(article, config),
      publicPublicationEvaluatedAt: now,
      ...(published && (options.contentChanged || !wasPublished || article.publicContentUpdatedAt === null)
        ? { publicContentUpdatedAt: now }
        : {}),
    },
  })
}

const publicationSelect = {
  id: true,
  aiStatus: true,
  score: true,
  isAd: true,
  publicOverride: true,
  publicStatus: true,
  publicPublishedAt: true,
  publicRevokedAt: true,
  publicContentUpdatedAt: true,
  source: { select: { publicEnabled: true, deletedAt: true } },
} as const

export async function refreshPublicPublication(
  articleId: string,
  client: PublicPublicationDb = db,
  options: { contentChanged?: boolean } = {},
): Promise<boolean> {
  const article = await client.article.findUnique({ where: { id: articleId }, select: publicationSelect })
  if (!article || !article.source) return false
  const config = await getPublicPublicationConfig(client)
  await syncCandidate(article, config, client, options)
  if (client === db) invalidatePublicArticleCache()
  return true
}

export async function refreshPublicPublications(
  articleIds: string[],
  client: PublicPublicationDb = db,
  options: { contentChanged?: boolean } = {},
): Promise<number> {
  const ids = [...new Set(articleIds.filter(Boolean))]
  if (ids.length === 0) return 0

  const articles = await client.article.findMany({ where: { id: { in: ids } }, select: publicationSelect })
  const config = await getPublicPublicationConfig(client)
  for (const article of articles) await syncCandidate(article, config, client, options)
  if (client === db) invalidatePublicArticleCache()
  return articles.length
}

export async function refreshPublicPublicationsForSource(
  sourceId: string,
  client: PublicPublicationDb = db,
): Promise<number> {
  const articles = await client.article.findMany({
    where: { sourceId },
    select: publicationSelect,
  })
  if (articles.length === 0) return 0
  const config = await getPublicPublicationConfig(client)
  for (const article of articles) await syncCandidate(article, config, client)
  return articles.length
}

/**
 * Recomputes the persisted public publication state once, after an infrequent
 * rule change. Public reads only consume publicStatus and do not recalculate
 * score/ad/source eligibility on every request.
 */
async function rebuildWithClient(
  client: PublicPublicationDb,
  options: { contentChanged?: boolean } = {},
): Promise<number> {
  const [articles, config] = await Promise.all([
    client.article.findMany({ select: publicationSelect }),
    getPublicPublicationConfig(client),
  ])
  for (const article of articles ?? []) await syncCandidate(article, config, client, options)
  return articles?.length ?? 0
}

export async function rebuildPublicPublicationSnapshot(
  client?: PublicPublicationDb,
  options: { contentChanged?: boolean } = {},
): Promise<number> {
  if (client) return rebuildWithClient(client, options)
  const count = await db.$transaction(
    (tx) => rebuildWithClient(tx, options),
    { maxWait: 10_000, timeout: 120_000 },
  )
  invalidatePublicArticleCache()
  return count
}

export async function updatePublicPublicationSetting(key: string, value: string): Promise<boolean> {
  if (!PUBLIC_PUBLICATION_REBUILD_KEYS.has(key)) return false

  await db.$transaction(async (tx) => {
    await tx.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    })
    await rebuildPublicPublicationSnapshot(tx)
  }, { maxWait: 10_000, timeout: 120_000 })
  invalidatePublicArticleCache()
  return true
}
