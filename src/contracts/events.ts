export interface EventSourceDto {
  name: string;
  type: string;
  publicEnabled: boolean;
  deleted: boolean;
}

export interface EventRepresentativeArticleDto {
  title: string;
  eventKey: string;
  score: number;
  brand: string;
  publishedAt: string | null;
  createdAt: string;
  source: EventSourceDto;
}

export interface EventCandidateDto {
  id: string;
  status: string;
  articleCount: number;
  publicStatus: string;
  pushedAt: string | null;
  representativeArticle: EventRepresentativeArticleDto | null;
}

export interface EventAuditDto {
  id: string;
  articleId: string;
  actor: string;
  action: string;
  decisionSource: string;
  confidence: number | null;
  evidence: Record<string, unknown>;
  createdAt: string;
  candidateEventId: string | null;
  candidateEvent: EventCandidateDto | null;
}

export interface EventArticleDto {
  id: string;
  title: string;
  url: string;
  eventKey: string;
  score: number;
  relevance: number;
  eventScore: number | null;
  contentScore: number | null;
  aiConfidence: number | null;
  aiStatus: string;
  publicStatus: string;
  publicOverride: string;
  pushStatus: string;
  isAd: boolean;
  brand: string;
  category: string;
  clusterStatus: string;
  publishedAt: string | null;
  createdAt: string;
  source: EventSourceDto;
}

export interface BrandCandidateDto {
  id: string;
  eventId: string;
  title: string;
  url: string;
  eventKey: string;
  score: number;
  relevance: number;
  brand: string;
  matchedBrands: string[];
  publicStatus: string;
  eventPushedAt: string | null;
  isEventRepresentative: boolean;
  publishedAt: string | null;
  createdAt: string;
  source: EventSourceDto;
}

export interface EventPushTargetStateDto {
  webhookRemark: string;
  latestStatus: 'success' | 'failure' | 'never_attempted' | 'unknown';
  latestCreatedAt: string | null;
  latestError: string | null;
}

export interface EventDetailDto {
  id: string;
  status: string;
  clusterReviewStatus: string;
  representativeArticleId: string | null;
  representativeManual: boolean;
  articleCount: number;
  pushedAt: string | null;
  publicStatus: string;
  firstSeenAt: string;
  lastSeenAt: string;
  pushTargetStates: EventPushTargetStateDto[];
  audits: EventAuditDto[];
  articles: EventArticleDto[];
  brandCandidates: BrandCandidateDto[];
}

export interface EventSearchOptionDto {
  id: string;
  articleCount: number;
  lastSeenAt: string;
  publicStatus: string;
  pushedAt: string | null;
  representativeArticle: {
    title: string;
    eventKey: string;
    score: number;
    relevance: number;
    publishedAt: string | null;
    source: { name: string };
  } | null;
}
