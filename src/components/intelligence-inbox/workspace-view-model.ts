import type { ArticleDetailDto } from "@/contracts/articles";
import { AI_ANALYSIS_REVIEW_CONFIDENCE_THRESHOLD } from "@/contracts/ai-confidence";
import { isBusinessSkipReason } from "@/lib/article-pipeline-status";
import { parseManualOverrides, type ManualOverrideField } from "@/lib/shared/article-calibration";
import { parseJsonArray, splitBrands, stripHtml } from "@/lib/shared/article-codecs";
import type {
  EventAudit,
  EventDetail,
  PushTargetSummary,
  WorkspaceStatusTone,
} from "./types";
import {
  EVENT_CLASSIFICATION_ACTIONS,
  latestPushTargetLogs,
  processingLabel,
  publicReasonLabel,
  pushTargetSummary,
} from "./utils";

export interface ArticleWorkspaceViewModel {
  manualOverrides: ManualOverrideField[];
  keyPoints: string[];
  brands: string[];
  latestPushLogs: ArticleDetailDto["pushLogs"];
  cleanContentText: string;
  eventMembers: EventDetail["articles"];
  eventArticleTitles: Map<string, string>;
  brandCandidates: EventDetail["brandCandidates"];
  eventSourceCount: number;
  currentArticleClassificationAudit: EventAudit | null;
  clickRate: number;
  isRepresentative: boolean;
  releaseStatus: string;
  pushSummary: PushTargetSummary;
  releaseGateMessage: string;
  currentConclusion: { label: string; tone: WorkspaceStatusTone };
  canForcePush: boolean;
}

export function createArticleWorkspaceViewModel(
  detail: ArticleDetailDto,
  eventDetail: EventDetail | null,
): ArticleWorkspaceViewModel {
  const manualOverrides = parseManualOverrides(detail.manualOverrides);
  const keyPoints = parseJsonArray(detail.keyPoints);
  const brands = splitBrands(detail.brand);
  const latestPushLogs = detail.pushLogs ? latestPushTargetLogs(detail.pushLogs) : [];
  const cleanContentText = detail.cleanContent ? stripHtml(detail.cleanContent) : '';
  const eventMembers = [...(eventDetail?.articles ?? [])].sort((left, right) => {
    if (left.id === detail.id) return -1;
    if (right.id === detail.id) return 1;
    const leftTime = new Date(left.publishedAt || left.createdAt).getTime();
    const rightTime = new Date(right.publishedAt || right.createdAt).getTime();
    return rightTime - leftTime;
  });
  const eventArticleTitles = new Map(eventMembers.map((article) => [article.id, article.title]));
  const brandCandidates = eventDetail?.brandCandidates ?? [];
  const eventSourceCount = new Set(eventMembers.map((article) => article.source.name)).size;
  const currentArticleClassificationAudit = eventDetail?.audits.find((audit) => (
    audit.articleId === detail.id && EVENT_CLASSIFICATION_ACTIONS.has(audit.action)
  )) ?? null;
  const clickRate = detail.viewCount > 0
    ? Math.round((detail.originalClickCount / detail.viewCount) * 100)
    : 0;
  const isRepresentative = detail.event?.representativeArticleId === detail.id;
  const currentEventMember = eventMembers.find((article) => article.id === detail.id) ?? null;
  const releaseStatus = eventDetail?.publicStatus ?? detail.publicStatus ?? "unknown";
  const pushSummary = pushTargetSummary(eventDetail?.pushTargetStates ?? []);
  const eventGateBlock = eventDetail
    ? eventDetail.status !== "active"
      ? "事件已并入其他事件，不能继续公开或推送"
      : eventDetail.clusterReviewStatus !== "confirmed"
        ? "事件待人工复核，不能公开或推送"
        : !eventDetail.representativeArticleId
          ? "事件尚未确定代表文章"
          : !isRepresentative
            ? "当前文章不是事件代表文章，公开与推送由代表文章决定"
            : currentEventMember?.source.publicEnabled === false
              ? "来源未开放公开"
              : detail.aiStatus !== "done"
                ? "AI 尚未完成"
                : detail.clusterStatus !== "clustered"
                  ? "文章尚未完成聚类"
                  : null
    : null;
  const processingState = processingLabel(detail);
  const processingError = detail.fetchStatus === "failed"
    || detail.aiStatus === "failed"
    || detail.clusterStatus === "failed";
  const lowAnalysisConfidence = typeof detail.aiConfidence === "number"
    && detail.aiConfidence < AI_ANALYSIS_REVIEW_CONFIDENCE_THRESHOLD;
  const businessSkipConclusion = detail.aiStatus === "skipped" && isBusinessSkipReason(detail.skipReason)
    ? "分析完成 · 无价值"
    : null;
  const releaseGateMessage = releaseStatus === "published"
    ? "已通过公开门禁"
    : businessSkipConclusion
      ? "该文章不进入事件公开与推送"
      : eventGateBlock || publicReasonLabel(detail.publicPublicationReason);
  const currentConclusion = processingError
    ? { label: `需要处理 · ${processingState}`, tone: "danger" as const }
    : eventDetail && eventDetail.clusterReviewStatus !== "confirmed"
      ? { label: "待人工复核 · 事件归属存在歧义", tone: "warning" as const }
      : eventDetail && eventDetail.status !== "active"
        ? { label: "事件已并入其他事件", tone: "neutral" as const }
        : businessSkipConclusion
          ? { label: businessSkipConclusion, tone: "neutral" as const }
          : lowAnalysisConfidence
            ? { label: `需人工复核 · AI 分析置信度低于 ${AI_ANALYSIS_REVIEW_CONFIDENCE_THRESHOLD}%`, tone: "warning" as const }
            : detail.eventId && !eventDetail
              ? { label: "事件信息加载中", tone: "neutral" as const }
              : !detail.eventId
                ? { label: "尚未归入事件 · 将自动建立独立事件", tone: "warning" as const }
                : !isRepresentative
                  ? { label: "已归入事件 · 当前文章为普通成员", tone: "neutral" as const }
                  : releaseStatus === "published"
                    ? { label: "已公开 · 当前为事件代表文章", tone: "success" as const }
                    : { label: "已归入事件 · 等待公开决策", tone: "warning" as const };
  const canForcePush = Boolean(
    eventDetail
      && isRepresentative
      && detail.clusterStatus === "clustered"
      && detail.aiStatus === "done",
  );

  return {
    manualOverrides,
    keyPoints,
    brands,
    latestPushLogs,
    cleanContentText,
    eventMembers,
    eventArticleTitles,
    brandCandidates,
    eventSourceCount,
    currentArticleClassificationAudit,
    clickRate,
    isRepresentative,
    releaseStatus,
    pushSummary,
    releaseGateMessage,
    currentConclusion,
    canForcePush,
  };
}
