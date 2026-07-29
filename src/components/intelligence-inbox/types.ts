import type { ArticleWorkspacePanel } from "@/components/article-workspace";

export type DetailPanel = ArticleWorkspacePanel;
export type WorkspaceStatusTone = "success" | "warning" | "danger" | "neutral" | "accent";

export interface ArticleEditorialDraft {
  summary: string;
  brand: string;
  category: string;
  eventSubjects: string;
  eventAction: string;
  eventObject: string;
  keyPoints: string;
}

export interface EventKeyParts {
  subjects: string;
  action: string;
  object: string;
}

export interface PushTargetSummary {
  label: string;
  tone: WorkspaceStatusTone;
}

export type ComparisonTarget = {
  kind: "recommended" | "brand";
  articleId: string | null;
  eventId: string;
  title: string;
  eventKey: string;
  brand: string;
  score: number | null;
  source: string;
  publishedAt: string | null;
  createdAt: string;
  matchedBrands: string[];
  reason: string;
  confidence: number | null;
};
export type EventDetail = {
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
  pushTargetStates: Array<{
    webhookRemark: string;
    latestStatus: "success" | "failure" | "never_attempted" | "unknown";
    latestCreatedAt: string | null;
    latestError: string | null;
  }>;
  audits: Array<{
    id: string;
    articleId: string;
    actor: string;
    action: string;
    decisionSource: string;
    confidence: number | null;
    evidence: Record<string, unknown>;
    createdAt: string;
    candidateEventId: string | null;
    candidateEvent: {
      id: string;
      status: string;
      articleCount: number;
      publicStatus: string;
      pushedAt: string | null;
      representativeArticle: {
        title: string;
        eventKey: string;
        score: number;
        brand: string;
        publishedAt: string | null;
        createdAt: string;
        source: { name: string; type: string; publicEnabled: boolean; deleted: boolean };
      } | null;
    } | null;
  }>;
  articles: Array<{
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
    source: { name: string; type: string; publicEnabled: boolean; deleted: boolean };
  }>;
  brandCandidates: Array<{
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
    source: { name: string; type: string; publicEnabled: boolean; deleted: boolean };
  }>;
};
export type EventAudit = EventDetail["audits"][number];

export type EventOption = {
  id: string;
  articleCount: number;
  lastSeenAt: string;
  publicStatus: string;
  pushedAt: string | null;
  representativeArticle: {
    title: string;
    score: number;
    relevance: number;
    publishedAt: string | null;
    source: { name: string };
  } | null;
};
