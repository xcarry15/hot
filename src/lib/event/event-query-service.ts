import { db } from '@/lib/db';
import { splitBrands } from '@/lib/shared/article-codecs';
import { compareArticleTime, sharedBrands } from '@/lib/event/event-representative';
import { getPushTargetStates } from '@/lib/push/delivery';

const SAME_BRAND_CANDIDATE_TAKE = 30;
const SAME_BRAND_CANDIDATE_WINDOW_DAYS = 30;
export async function getEventArticles(eventId: string, articleId?: string) {
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      status: true,
      clusterReviewStatus: true,
      representativeArticleId: true,
      representativeManual: true,
      articleCount: true,
      publicStatus: true,
      pushedAt: true,
      firstSeenAt: true,
      lastSeenAt: true,
      pushLogs: {
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          representativeArticleId: true,
          targetId: true,
          status: true,
          webhookUrl: true,
          webhookRemark: true,
        },
      },
      articles: {
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          title: true,
          url: true,
          eventKey: true,
          score: true,
          relevance: true,
          eventScore: true,
          contentScore: true,
          aiConfidence: true,
          aiStatus: true,
          publicStatus: true,
          publicOverride: true,
          isAd: true,
          brand: true,
          category: true,
          clusterStatus: true,
          publishedAt: true,
          createdAt: true,
          source: { select: { name: true, type: true, publicEnabled: true, deletedAt: true } },
        },
      },
      assignedAudits: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          articleId: true,
          candidateEventId: true,
          actor: true,
          action: true,
          decisionSource: true,
          confidence: true,
          evidence: true,
          createdAt: true,
          candidateEvent: {
            select: {
              id: true,
              status: true,
              articleCount: true,
              publicStatus: true,
              pushedAt: true,
              representativeArticle: {
                select: {
                  title: true,
                  eventKey: true,
                  score: true,
                  brand: true,
                  publishedAt: true,
                  createdAt: true,
                  source: { select: { name: true, type: true, publicEnabled: true, deletedAt: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!event) return null;
  const { pushLogs, ...eventData } = event;
  const articlePushStatuses = getLatestArticlePushStatuses(pushLogs);
  const pushTargetStates = await getPushTargetStates(eventId);
  const currentRepresentativeStatus = getPushStatusFromTargetStates(pushTargetStates);
  if (event.representativeArticleId && currentRepresentativeStatus !== 'none') {
    articlePushStatuses.set(event.representativeArticleId, currentRepresentativeStatus);
  }
  const parsedAudits = event.assignedAudits.map((audit) => ({ ...audit, evidence: parseAuditEvidence(audit.evidence) }));
  const focusArticle = event.articles.find((article) => article.id === articleId)
    ?? event.articles.find((article) => article.id === event.representativeArticleId)
    ?? event.articles[0];
  const focusArticleId = articleId ?? focusArticle?.id;
  // 候选关联区域展示的是当前文章审计中选中的候选 Event 代表文章；
  // 同品牌区域是更宽的召回，必须排除已经在候选关联展示的 Event，避免同一文章跨区重复。
  const displayedCandidateEventId = parsedAudits.find((audit) => (
    audit.articleId === focusArticleId
    && audit.actor === 'system'
    && (audit.action === 'create' || audit.action === 'fallback_create')
    && audit.candidateEventId !== null
    && audit.candidateEventId !== event.id
    && audit.candidateEvent?.status === 'active'
    && audit.candidateEvent.representativeArticle !== null
  ))?.candidateEventId ?? null;
  const brandCandidates = focusArticle
    ? await getSameBrandCandidates(
        eventId,
        focusArticle.brand,
        displayedCandidateEventId ? [displayedCandidateEventId] : [],
      )
    : [];
  const candidateIds = [...new Set(parsedAudits.flatMap((audit) => {
    const candidates = audit.evidence.candidates;
    if (!Array.isArray(candidates)) return [];
    return candidates.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return [];
      const id = (candidate as { candidateEventId?: unknown }).candidateEventId;
      return typeof id === 'string' ? [id] : [];
    });
  }))];
  const candidateEvents = candidateIds.length === 0 ? [] : await db.event.findMany({
    where: { id: { in: candidateIds } },
    select: { id: true, representativeArticle: { select: { title: true } } },
  });
  const candidateTitles = new Map(candidateEvents.map((candidate) => [candidate.id, candidate.representativeArticle?.title ?? '']));
  return {
    ...eventData,
    pushedAt: event.pushedAt?.toISOString() ?? null,
    firstSeenAt: event.firstSeenAt.toISOString(),
    lastSeenAt: event.lastSeenAt.toISOString(),
    pushTargetStates: pushTargetStates.map((s) => ({
      ...s,
      latestCreatedAt: s.latestCreatedAt?.toISOString() ?? null,
    })),
    audits: parsedAudits.map((audit) => ({
      ...audit,
      evidence: {
        ...audit.evidence,
        ...(Array.isArray(audit.evidence.candidates) ? {
          candidates: audit.evidence.candidates.map((candidate) => {
            if (!candidate || typeof candidate !== 'object') return candidate;
            const value = candidate as Record<string, unknown>;
            const id = typeof value.candidateEventId === 'string' ? value.candidateEventId : '';
            return { ...value, candidateTitle: candidateTitles.get(id) || '' };
          }),
        } : {}),
      },
      createdAt: audit.createdAt.toISOString(),
      candidateEvent: audit.candidateEvent ? {
        ...audit.candidateEvent,
        pushedAt: audit.candidateEvent.pushedAt?.toISOString() ?? null,
        representativeArticle: audit.candidateEvent.representativeArticle ? {
          ...audit.candidateEvent.representativeArticle,
          publishedAt: audit.candidateEvent.representativeArticle.publishedAt?.toISOString() ?? null,
          createdAt: audit.candidateEvent.representativeArticle.createdAt.toISOString(),
          source: {
            name: audit.candidateEvent.representativeArticle.source.name,
            type: audit.candidateEvent.representativeArticle.source.type,
            publicEnabled: audit.candidateEvent.representativeArticle.source.publicEnabled,
            deleted: audit.candidateEvent.representativeArticle.source.deletedAt !== null,
          },
        } : null,
      } : null,
    })),
    articles: event.articles.map((article) => ({
      ...article,
      pushStatus: articlePushStatuses.get(article.id) ?? 'none',
      source: {
        name: article.source.name,
        type: article.source.type,
        publicEnabled: article.source.publicEnabled,
        deleted: article.source.deletedAt !== null,
      },
      publishedAt: article.publishedAt?.toISOString() ?? null,
      createdAt: article.createdAt.toISOString(),
    })),
    brandCandidates,
  };
}

function parseAuditEvidence(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

type ArticlePushStatus = 'success' | 'partial' | 'failure' | 'none';

function getLatestArticlePushStatuses(logs: Array<{
  id: string;
  representativeArticleId: string | null;
  targetId: string | null;
  status: string;
  webhookUrl: string;
  webhookRemark: string;
}>): Map<string, ArticlePushStatus> {
  const latestByTarget = new Map<string, (typeof logs)[number]>();
  for (const log of logs) {
    const target = log.targetId || log.webhookRemark || log.webhookUrl || log.id;
    if (!latestByTarget.has(target)) latestByTarget.set(target, log);
  }

  const statuses = new Map<string, { success: boolean; failure: boolean }>();
  for (const log of latestByTarget.values()) {
    if (!log.representativeArticleId) continue;
    const current = statuses.get(log.representativeArticleId) ?? { success: false, failure: false };
    if (log.status === 'success') current.success = true;
    else current.failure = true;
    statuses.set(log.representativeArticleId, current);
  }

  return new Map([...statuses].map(([articleId, status]) => [
    articleId,
    status.success && status.failure
      ? 'partial'
      : status.success
        ? 'success'
        : 'failure',
  ]));
}

function getPushStatusFromTargetStates(targets: Array<{ latestStatus: string }>): ArticlePushStatus {
  const latest = targets.filter((target) => target.latestStatus !== 'never_attempted');
  if (latest.length === 0) return 'none';
  const successCount = latest.filter((target) => target.latestStatus === 'success').length;
  if (successCount === latest.length) return 'success';
  if (successCount > 0) return 'partial';
  return 'failure';
}


/**
 * 查询正文抽屉中的同品牌候选文章，查询规则集中在 Event 查询层。
 * excludedEventIds 用于排除已在“候选关联”区域展示的候选 Event，保证两个区域互斥。
 */
export async function getSameBrandCandidates(
  eventId: string,
  brand: string,
  excludedEventIds: readonly string[] = [],
) {
  const brands = splitBrands(brand);
  if (brands.length === 0) return [];

  const cutoff = new Date(Date.now() - SAME_BRAND_CANDIDATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const timeWindow = {
    OR: [
      { publishedAt: { gte: cutoff } },
      { publishedAt: null, createdAt: { gte: cutoff } },
    ],
  };
  const excludedEvents = [...new Set([eventId, ...excludedEventIds].filter(Boolean))];
  const baseWhere = {
    eventId: { notIn: excludedEvents },
    aiStatus: 'done',
    event: { is: { status: 'active' } },
    source: { deletedAt: null },
  } as const;
  const select = {
    id: true,
    eventId: true,
    title: true,
    url: true,
    eventKey: true,
    score: true,
    relevance: true,
    brand: true,
    publicStatus: true,
    publishedAt: true,
    createdAt: true,
    source: { select: { name: true, type: true, publicEnabled: true, deletedAt: true } },
    event: { select: { pushedAt: true, representativeArticleId: true } },
  } as const;

  // 先命中完全相同的品牌字段，再用品牌片段补齐多品牌/历史格式数据。
  const exact = await db.article.findMany({
    where: { ...baseWhere, ...timeWindow, brand: { equals: brand } },
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    take: SAME_BRAND_CANDIDATE_TAKE * 2,
    select,
  });
  const broad = exact.length >= SAME_BRAND_CANDIDATE_TAKE
    ? []
    : await db.article.findMany({
        where: {
          ...baseWhere,
          AND: [
            timeWindow,
            { OR: brands.map((item) => ({ brand: { contains: item } })) },
          ],
        },
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        take: SAME_BRAND_CANDIDATE_TAKE * 4,
        select,
      });

  const candidates = [...exact, ...broad]
    .filter((article, index, all) => all.findIndex((item) => item.id === article.id) === index)
    .map((article) => ({
      ...article,
      matchedBrands: sharedBrands(brand, article.brand),
    }))
    .filter((article) => article.matchedBrands.length > 0)
    .sort(compareArticleTime)
    .slice(0, SAME_BRAND_CANDIDATE_TAKE);

  return candidates.map(({ event, source, ...article }) => ({
    ...article,
    eventPushedAt: event?.pushedAt?.toISOString() ?? null,
    isEventRepresentative: event?.representativeArticleId === article.id,
    source: {
      name: source.name,
      type: source.type,
      publicEnabled: source.publicEnabled,
      deleted: source.deletedAt !== null,
    },
    publishedAt: article.publishedAt?.toISOString() ?? null,
    createdAt: article.createdAt.toISOString(),
  }));
}

export async function searchActiveEvents(query: string, excludeEventId?: string) {
  const term = query.trim();
  const events = await db.event.findMany({
    where: {
      status: 'active',
      ...(excludeEventId ? { id: { not: excludeEventId } } : {}),
      ...(term ? {
        OR: [
          { id: { contains: term } },
          { representativeArticle: { is: { title: { contains: term } } } },
          { articles: { some: { OR: [
            { title: { contains: term } },
            { brand: { contains: term } },
            { eventKey: { contains: term } },
          ] } } },
        ],
      } : { lastSeenAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } }),
    },
    orderBy: { lastSeenAt: 'desc' },
    take: 20,
    select: {
      id: true,
      articleCount: true,
      lastSeenAt: true,
      publicStatus: true,
      pushedAt: true,
      representativeArticle: {
        select: {
          title: true,
          eventKey: true,
          score: true,
          relevance: true,
          publishedAt: true,
          source: { select: { name: true } },
        },
      },
    },
  });
  return events.map((event) => ({
    ...event,
    lastSeenAt: event.lastSeenAt.toISOString(),
    pushedAt: event.pushedAt?.toISOString() ?? null,
    representativeArticle: event.representativeArticle ? {
      ...event.representativeArticle,
      publishedAt: event.representativeArticle.publishedAt?.toISOString() ?? null,
    } : null,
  }));
}
