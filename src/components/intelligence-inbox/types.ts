import type { ArticleWorkspacePanel } from '@/components/article-workspace';
import type { EventDetailDto, EventSearchOptionDto } from '@/contracts/events';

export type DetailPanel = ArticleWorkspacePanel;
export type WorkspaceStatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent';

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
  kind: 'recommended' | 'brand';
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

export type EventDetail = EventDetailDto;
export type EventAudit = EventDetail['audits'][number];
export type EventOption = EventSearchOptionDto;
