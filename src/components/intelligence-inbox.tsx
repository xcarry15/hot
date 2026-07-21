"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Eye,
  ExternalLink,
  FileText,
  Loader2,
  Merge,
  MousePointerClick,
  RefreshCcw,
  Save,
  Search,
  Send,
  Split,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { ArticleWorkspacePanel } from "@/components/article-workspace";
import type {
  ArticleDetailDto,
  ArticleListItemDto,
  ArticlePushLogDto,
} from "@/contracts/articles";
import {
  fetchArticleDetail,
  invalidateArticleDetailCache,
  reviewArticle,
  triggerArticleWorkflow,
  updateArticleEditorial,
} from "@/features/articles-api.client";
import {
  getSnapshotValue,
  parseManualOverrides,
} from "@/lib/shared/article-calibration";
import { isRequestAborted, isRequestJsonError } from "@/lib/request-json.client";
import {
  parseJsonArray,
  splitBrands,
  stripHtml,
} from "@/lib/shared/article-codecs";
import { parseEventSubjects } from "@/contracts/event-identity";

type NumericField =
  "relevance" | "eventScore" | "contentScore" | "adProbability";
type DetailPanel = ArticleWorkspacePanel;
type EventDetail = {
  id: string;
  representativeArticleId: string | null;
  representativeManual: boolean;
  articleCount: number;
  pushedAt: string | null;
  publicStatus: string;
  firstSeenAt: string;
  lastSeenAt: string;
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
      representativeArticle: { title: string } | null;
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
    reviewStatus: string;
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
    score: number;
    relevance: number;
    brand: string;
    matchedBrands: string[];
    publicStatus: string;
    publishedAt: string | null;
    createdAt: string;
    source: { name: string; type: string; publicEnabled: boolean };
  }>;
};

const REASONS = [
  ["low_score", "评分偏低"],
  ["ad_misclassification", "误判软文"],
  ["wrong_brand", "品牌错误"],
  ["keyword_ambiguity", "关键词歧义"],
  ["poor_summary", "摘要较差"],
] as const;

const WORKSPACE_ACTION_CLASS = "h-7 rounded-none px-2 text-xs font-medium";

const FULL_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function reviewLabel(status: string): string {
  return (
    (
      {
        unreviewed: "未归类",
        important: "重要",
        general: "一般",
        irrelevant: "无关",
      } as Record<string, string>
    )[status] ?? status
  );
}

function timeLabel(value: string): string {
  const date = new Date(value);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function processingLabel(
  item: Pick<
    ArticleListItemDto,
    "aiStatus" | "fetchStatus" | "skipReason" | "clusterStatus"
  >,
): string {
  if (item.fetchStatus === "failed") return "抓取失败";
  if (item.fetchStatus === "pending" && item.aiStatus !== "done")
    return "待抓取";
  if (item.aiStatus === "failed") return "AI失败";
  if (item.aiStatus === "skipped" && item.skipReason?.includes("内容不足"))
    return "正文不足";
  if (item.aiStatus === "skipped") return "已跳过";
  if (item.aiStatus === "pending") return "分析中";
  if (item.clusterStatus === "failed") return "聚类失败";
  if (item.clusterStatus === "needs_review") return "聚类复核";
  return "正常";
}


function clusterLabel(item: ArticleListItemDto): string {
  if (item.clusterStatus === "pending") return "待聚类";
  if (item.clusterStatus === "failed") return "聚类失败";
  if (item.clusterStatus === "needs_review") return "待复核";
  const count = item.event?.articleCount ?? 1;
  const representative = item.event?.representativeArticleId === item.id;
  return count <= 1
    ? representative
      ? "单来源·代表"
      : "单来源"
    : `${count}来源${representative ? "·代表" : ""}`;
}


function publicResultLabel(
  item: Pick<ArticleListItemDto, "publicStatus">,
): string {
  return item.publicStatus === "published"
    ? "已公开"
    : item.publicStatus === "revoked"
      ? "已撤回"
      : "未公开";
}

function publicReasonLabel(reason: string): string {
  return (
    (
      {
        eligible: "符合公开规则",
        "ai-not-done": "AI尚未完成",
        "source-disabled": "来源未开放公开",
        "manual-hidden": "人工隐藏",
        "score-below-threshold": "评分低于公开阈值",
        "ad-hidden": "软文规则隐藏",
        "event-not-ready": "事件尚未完成聚类",
        "not-event-representative": "当前文章不是 Event 代表",
        "not-publicly-eligible": "不符合公开规则",
      } as Record<string, string>
    )[reason] ?? "等待公开规则评估"
  );
}

function fullTimeLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return FULL_DATE_TIME_FORMATTER.format(new Date(value));
}

function pushStatusLabel(status: string): string {
  return status === "success"
    ? "成功"
    : status === "failed" || status === "failure"
      ? "失败"
      : status;
}

function articlePushStatusLabel(status: string): string {
  return status === "success"
    ? "已推送"
    : status === "partial"
      ? "部分推送"
      : status === "failure"
        ? "推送失败"
        : "未推送";
}

function clusterAuditActionLabel(action: string): string {
  return ({
    create: "创建事件",
    attach: "并入事件",
    fallback_create: "创建待复核事件",
    representative_change: "调整代表文章",
    split: "拆分文章",
    merge: "合并事件",
    manual_create: "创建独立事件",
    confirm_independent: "确认独立事件",
  } as Record<string, string>)[action] ?? action;
}

function clusterAuditReason(audit: {
  evidence: Record<string, unknown>;
}): string {
  const aiDecision = audit.evidence.aiDecision;
  const aiReason = aiDecision && typeof aiDecision === "object"
    ? (aiDecision as { reason?: unknown }).reason
    : undefined;
  const reason = aiReason ?? audit.evidence.reason ?? audit.evidence.aiReason;
  return typeof reason === "string" && reason.trim() && reason !== "无补充理由"
    ? reason
    : "";
}

function stageStatusLabel(stage: "fetch" | "cluster" | "ai", status: string): string {
  const labels: Record<"fetch" | "cluster" | "ai", Record<string, string>> = {
    fetch: { pending: "待处理", success: "已完成", failed: "失败" },
    cluster: { pending: "待聚类", clustered: "已聚类", needs_review: "待复核", failed: "失败" },
    ai: { pending: "待分析", done: "已完成", skipped: "已跳过", failed: "失败" },
  };
  return labels[stage][status] ?? status;
}

function latestPushTargetLogs(logs: ArticlePushLogDto[]): ArticlePushLogDto[] {
  const latest = new Map<string, ArticlePushLogDto>();
  for (const log of logs) {
    const target = log.webhookTarget || log.webhookRemark || log.id;
    if (!latest.has(target)) latest.set(target, log);
  }
  return [...latest.values()];
}

function manualFieldLabel(field: string): string {
  return (
    {
      summary: "AI 洞察",
      brand: "品牌",
      category: "分类",
      eventSubjects: "事件主体",
      eventAction: "事件行为",
      eventObject: "具体事项",
      keyPoints: "核心要点",
      relevance: "相关度",
      eventScore: "事件分",
      contentScore: "内容分",
      adProbability: "广告概率",
      isAd: "内容判断",
    } as Record<string, string>
  )[field] ?? field;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface IntelligenceInboxProps {
  articleId?: string | null;
  initialPanel?: DetailPanel | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onArticleChange?: (articleId: string | null, panel?: DetailPanel | null) => void;
  onChanged?: () => void;
}

export default function IntelligenceInbox({
  articleId = null,
  initialPanel = null,
  open = false,
  onOpenChange,
  onArticleChange,
  onChanged,
}: IntelligenceInboxProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArticleDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [rowSavingId, setRowSavingId] = useState<string | null>(null);
  const [detailAction, setDetailAction] = useState<
    "review" | "edit" | "workflow" | null
  >(null);
  const [reasonTags, setReasonTags] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [showFullContent, setShowFullContent] = useState(false);
  const [requestedPanel, setRequestedPanel] = useState<DetailPanel | null>(null);
  const [eventDetail, setEventDetail] = useState<EventDetail | null>(null);
  const [eventAction, setEventAction] = useState<string | null>(null);
  const [selectedSplitIds, setSelectedSplitIds] = useState<Set<string>>(() => new Set());
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [eventSearch, setEventSearch] = useState("");
  const [eventOptions, setEventOptions] = useState<
    Array<{
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
    }>
  >([]);
  const [draft, setDraft] = useState({
    summary: "",
    brand: "",
    category: "",
    eventSubjects: "",
    eventAction: "",
    eventObject: "",
    keyPoints: "",
  });
  const clusterPanelRef = useRef<HTMLDivElement>(null);
  const contentPanelRef = useRef<HTMLDivElement>(null);
  const rowWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const rowSavingRef = useRef<string | null>(null);
  const eventDetailRequestRef = useRef(0);
  const eventSearchRequestRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const initialPanelRef = useRef<DetailPanel | null>(initialPanel);

  useEffect(() => {
    initialPanelRef.current = initialPanel;
  }, [initialPanel]);

  useEffect(() => {
    setSelectedId(articleId);
    selectedIdRef.current = articleId;
    eventDetailRequestRef.current += 1;
    eventSearchRequestRef.current += 1;
    setEventDetail(null);
    setEventOptions([]);
    setEventSearch("");
    setMergeTargetId("");
    setSelectedSplitIds(new Set());
  }, [articleId]);

  useEffect(() => {
    setRequestedPanel(initialPanel);
  }, [initialPanel]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const updateDetailUrl = useCallback((articleId: string | null, panel?: DetailPanel | null) => {
    onArticleChange?.(articleId, panel);
  }, [onArticleChange]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    const requestedId = selectedId;
    const controller = new AbortController();
    setDetail(null);
    setDetailLoading(true);
    fetchArticleDetail(requestedId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || result.id !== requestedId) return;
        setDetail(result);
        setReasonTags(parseJsonArray(result.reviewReasonTags));
        setEditing(false);
        setShowFullContent(false);
        setDraft({
          summary: result.summary,
          brand: splitBrands(result.brand).join("，"),
          category: result.category,
          eventSubjects: parseEventSubjects(result.eventSubjects).join("，"),
          eventAction: result.eventAction,
          eventObject: result.eventObject,
          keyPoints: parseJsonArray(result.keyPoints).join("\n"),
        });
      })
      .catch((error) => {
        if (isRequestAborted(error)) return;
        if (isRequestJsonError(error, 404)) {
          invalidateArticleDetailCache(requestedId);
          setSelectedId((current) => current === requestedId ? null : current);
          setRequestedPanel(null);
          updateDetailUrl(null, null);
          onOpenChange?.(false);
          toast.info("目标文章已不存在");
          return;
        }
        toast.error(errorMessage(error, "文章详情加载失败"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [onOpenChange, selectedId, updateDetailUrl]);

  useEffect(() => {
    if (!detail || detail.id !== selectedId || !requestedPanel) return;
    if (requestedPanel === "content") setShowFullContent(true);
    const target = requestedPanel === "cluster" ? clusterPanelRef.current : contentPanelRef.current;
    requestAnimationFrame(() => target?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [detail, eventDetail, requestedPanel, selectedId]);

  const loadEventDetail = useCallback(
    async (eventId: string | null | undefined, signal?: AbortSignal) => {
      const requestId = ++eventDetailRequestRef.current;
      if (!eventId) {
        setEventDetail(null);
        return;
      }
      try {
        const query = new URLSearchParams();
        if (detail?.id) query.set("articleId", detail.id);
        const response = await fetch(
          `/api/events/${encodeURIComponent(eventId)}${query.size > 0 ? `?${query.toString()}` : ""}`,
          { signal },
        );
        if (!response.ok) throw new Error("事件详情加载失败");
        const result = (await response.json()) as EventDetail;
        if (signal?.aborted || requestId !== eventDetailRequestRef.current) return;
        setEventDetail(result);
      } catch (error) {
        if (
          signal?.aborted ||
          requestId !== eventDetailRequestRef.current ||
          isRequestAborted(error)
        )
          return;
        setEventDetail(null);
        toast.error(errorMessage(error, "事件详情加载失败"));
      }
    },
    [detail?.id],
  );

  const refreshArticleDetail = useCallback(async (articleId: string) => {
    invalidateArticleDetailCache(articleId);
    const updated = await fetchArticleDetail(articleId);
    if (selectedIdRef.current === articleId) setDetail(updated);
    return updated;
  }, []);

  const refreshSelectedEvent = useCallback(async (updated: ArticleDetailDto) => {
    if (selectedIdRef.current === updated.id) {
      await loadEventDetail(updated.eventId);
    }
  }, [loadEventDetail]);

  const refreshAfterMutation = useCallback(() => {
    onChanged?.();
  }, [onChanged]);

  useEffect(() => {
    const controller = new AbortController();
    void loadEventDetail(detail?.eventId, controller.signal);
    return () => controller.abort();
  }, [detail?.eventId, detail?.id, loadEventDetail]);

  useEffect(() => {
    eventSearchRequestRef.current += 1;
    setEventOptions([]);
    setEventSearch("");
    setMergeTargetId("");
    setSelectedSplitIds(new Set());
  }, [detail?.eventId]);

  const setRepresentative = async (articleId: string) => {
    if (!detail?.eventId || eventAction) return;
    setEventAction("representative");
    try {
      const response = await fetch(
        `/api/events/${encodeURIComponent(detail.eventId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ representativeArticleId: articleId }),
        },
      );
      if (!response.ok)
        throw new Error(
          ((await response.json().catch(() => ({}))) as { error?: string })
            .error || "指定代表文章失败",
        );
      const updated = await refreshArticleDetail(detail.id);
      await refreshSelectedEvent(updated);
      refreshAfterMutation();
      toast.success("代表文章已更新");
    } catch (error) {
      toast.error(errorMessage(error, "指定代表文章失败"));
    } finally {
      setEventAction(null);
    }
  };

  const splitArticles = async (articleIds: string[]) => {
    if (
      !detail?.eventId ||
      eventAction ||
      articleIds.length === 0 ||
      articleIds.length >= (eventDetail?.articleCount ?? 0)
    )
      return;
    const titles = eventDetail?.articles
      .filter((article) => articleIds.includes(article.id))
      .map((article) => article.title) ?? [];
    if (!window.confirm(`将 ${articleIds.length} 篇文章拆为一个新的独立 Event：\n${titles.slice(0, 3).join("\n")}${titles.length > 3 ? `\n等 ${titles.length} 篇` : ""}\n\n历史推送不会撤回，新 Event 默认不会补推。确认继续吗？`)) return;
    setEventAction(`split:${articleIds.join(",")}`);
    try {
      const response = await fetch(
        `/api/events/${encodeURIComponent(detail.eventId)}/split`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ articleIds }),
        },
      );
      if (!response.ok)
        throw new Error(
          ((await response.json().catch(() => ({}))) as { error?: string })
            .error || "拆分事件失败",
        );
      for (const articleId of articleIds) {
        if (articleId !== detail.id) invalidateArticleDetailCache(articleId);
      }
      setSelectedSplitIds(new Set());
      const updated = await refreshArticleDetail(detail.id);
      await refreshSelectedEvent(updated);
      refreshAfterMutation();
      toast.success(`${articleIds.length} 篇文章已拆分为新事件，默认不会补推`);
    } catch (error) {
      toast.error(errorMessage(error, "拆分事件失败"));
    } finally {
      setEventAction(null);
    }
  };

  const splitArticle = async (articleId: string) => splitArticles([articleId]);

  const mergeCurrentEvent = async () => {
    if (!detail?.eventId || !mergeTargetId.trim() || eventAction) return;
    const target = eventOptions.find((event) => event.id === mergeTargetId.trim());
    if (!window.confirm(`将当前整个 Event（${eventDetail?.articleCount ?? 0} 篇）合并到：\n${target?.representativeArticle?.title || mergeTargetId.trim()}\n\n当前 Event 会停止独立展示，历史推送不会撤回。确认继续吗？`)) return;
    setEventAction("merge");
    try {
      const response = await fetch("/api/events/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceEventId: detail.eventId,
          targetEventId: mergeTargetId.trim(),
        }),
      });
      if (!response.ok)
        throw new Error(
          ((await response.json().catch(() => ({}))) as { error?: string })
            .error || "合并事件失败",
        );
      setMergeTargetId("");
      const updated = await refreshArticleDetail(detail.id);
      await refreshSelectedEvent(updated);
      refreshAfterMutation();
      toast.success("事件已合并，不会补推或撤回历史消息");
    } catch (error) {
      toast.error(errorMessage(error, "合并事件失败"));
    } finally {
      setEventAction(null);
    }
  };

  const searchEvents = async (query = eventSearch) => {
    if (!detail?.eventId) return;
    const requestId = ++eventSearchRequestRef.current;
    try {
      const response = await fetch(
        `/api/events/search?q=${encodeURIComponent(query)}&excludeEventId=${encodeURIComponent(detail.eventId)}`,
      );
      if (!response.ok) throw new Error("事件搜索失败");
      const result = await response.json();
      if (requestId !== eventSearchRequestRef.current) return;
      setEventOptions(result);
    } catch (error) {
      if (requestId !== eventSearchRequestRef.current) return;
      toast.error(errorMessage(error, "事件搜索失败"));
    }
  };

  const moveCurrentArticle = async (targetEventId: string) => {
    if (!detail?.eventId || eventAction) return;
    const target = eventOptions.find((event) => event.id === targetEventId);
    if (!window.confirm(`把当前文章移入目标 Event：\n${target?.representativeArticle?.title || targetEventId}\n\n当前 Event 和目标 Event 的代表文章、公开状态会自动重新计算。确认继续吗？`)) return;
    setEventAction("move");
    try {
      const response = await fetch(
        `/api/events/${encodeURIComponent(detail.eventId)}/move`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ articleId: detail.id, targetEventId }),
        },
      );
      if (!response.ok)
        throw new Error(
          ((await response.json().catch(() => ({}))) as { error?: string })
            .error || "移动文章失败",
        );
      setEventOptions([]);
      setEventSearch("");
      const updated = await refreshArticleDetail(detail.id);
      await refreshSelectedEvent(updated);
      refreshAfterMutation();
      toast.success("文章已移入目标事件");
    } catch (error) {
      toast.error(errorMessage(error, "移动文章失败"));
    } finally {
      setEventAction(null);
    }
  };

  const moveBrandCandidate = async (candidate: EventDetail["brandCandidates"][number]) => {
    if (!detail?.eventId || !eventDetail || eventAction) return;
    if (!window.confirm(`将文章移入当前 Event：\n${candidate.title}\n\n当前 Event 将新增 1 篇成员，代表文章和公开状态会自动重新计算。确认继续吗？`)) return;
    setEventAction(`move-candidate:${candidate.id}`);
    try {
      const response = await fetch(
        `/api/events/${encodeURIComponent(eventDetail.id)}/move`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ articleId: candidate.id, targetEventId: eventDetail.id }),
        },
      );
      if (!response.ok)
        throw new Error(
          ((await response.json().catch(() => ({}))) as { error?: string })
            .error || "移动同品牌候选失败",
        );
      const updated = await refreshArticleDetail(detail.id);
      await refreshSelectedEvent(updated);
      refreshAfterMutation();
      toast.success("同品牌候选已移入当前 Event");
    } catch (error) {
      toast.error(errorMessage(error, "移动同品牌候选失败"));
    } finally {
      setEventAction(null);
    }
  };

  const confirmIndependent = async () => {
    if (!detail?.eventId || eventAction) return;
    setEventAction("confirm");
    try {
      const response = await fetch(
        `/api/events/${encodeURIComponent(detail.eventId)}/confirm-independent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ articleId: detail.id }),
        },
      );
      if (!response.ok)
        throw new Error(
          ((await response.json().catch(() => ({}))) as { error?: string })
            .error || "确认失败",
        );
      const updated = await refreshArticleDetail(detail.id);
      await refreshSelectedEvent(updated);
      refreshAfterMutation();
      toast.success("已确认这是独立事件");
    } catch (error) {
      toast.error(errorMessage(error, "确认失败"));
    } finally {
      setEventAction(null);
    }
  };

  const pushCurrentEvent = async (mode: "manual" | "repush") => {
    if (!detail?.eventId || !eventDetail || eventAction) return;
    const actionLabel = mode === "repush" ? "完整重新推送" : "强制推送";
    if (
      !window.confirm(
        `${actionLabel}：${detail.title}\n事件共 ${eventDetail.articleCount} 个来源${eventDetail.pushedAt ? `，上次推送 ${timeLabel(eventDetail.pushedAt)}` : ""}。${mode === "manual" ? "本次会绕过评分、相关度和自动推送开关，但仍要求聚类及 AI 已完成。" : "本次会向全部启用目标再次发送。"}确认继续吗？`,
      )
    )
      return;
    setEventAction("push");
    try {
      const response = await fetch(
        `/api/events/${encodeURIComponent(detail.eventId)}/push`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      if (!response.ok) throw new Error(result.message || "事件推送失败");
      toast.success(result.message || `${actionLabel}完成`);
      if (selectedIdRef.current === detail.id) {
        const updated = await refreshArticleDetail(detail.id);
        await refreshSelectedEvent(updated);
      }
      refreshAfterMutation();
    } catch (error) {
      toast.error(errorMessage(error, "事件推送失败"));
    } finally {
      setEventAction(null);
    }
  };

  const recommendedEventId =
    eventDetail?.audits.find(
      (audit) =>
        audit.articleId === detail?.id &&
        audit.actor === "system" &&
        audit.candidateEvent?.status === "active",
    )?.candidateEventId ?? null;

  const toggleSplitSelection = useCallback((articleId: string) => {
    setSelectedSplitIds((current) => {
      const next = new Set(current);
      if (next.has(articleId)) {
        next.delete(articleId);
        return next;
      }
      if (eventDetail && next.size + 1 >= eventDetail.articleCount) {
        toast.info("至少保留一篇文章在当前 Event");
        return current;
      }
      next.add(articleId);
      return next;
    });
  }, [eventDetail]);

  const selectArticle = useCallback((nextArticleId: string, panel?: DetailPanel | null) => {
    setSelectedId(nextArticleId);
    if (panel !== undefined) setRequestedPanel(panel);
    onArticleChange?.(nextArticleId, panel);
  }, [onArticleChange]);

  const patchRow = useCallback((updated: ArticleDetailDto) => {
    setDetail((current) => (current?.id === updated.id ? updated : current));
  }, []);

  const queueRowUpdate = useCallback(
    (
      id: string,
      input: Parameters<typeof updateArticleEditorial>[1],
      message: string,
    ) => {
      if (rowSavingRef.current) {
        toast.info("请等待当前修改保存完成");
        return;
      }
      rowSavingRef.current = id;
      setRowSavingId(id);
      rowWriteQueue.current = rowWriteQueue.current
        .then(async () => {
          const updated = await updateArticleEditorial(id, input);
          patchRow(updated);
          await refreshSelectedEvent(updated);
          refreshAfterMutation();
          toast.success(message);
        })
        .catch((error) => toast.error(errorMessage(error, "更新失败")))
        .finally(() => {
          rowSavingRef.current = null;
          setRowSavingId(null);
        })
        .then(() => undefined);
    },
    [patchRow, refreshAfterMutation, refreshSelectedEvent],
  );

  const saveEditorial = async () => {
    if (!selectedId || detail?.id !== selectedId) return;
    const nextSubjects = draft.eventSubjects
      .split(/[,，、+\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    const identityChanged = JSON.stringify(nextSubjects) !== JSON.stringify(parseEventSubjects(detail.eventSubjects))
      || draft.eventAction.trim() !== detail.eventAction
      || draft.eventObject.trim() !== detail.eventObject;
    setDetailAction("edit");
    try {
      const updated = await updateArticleEditorial(selectedId, {
        ...(draft.summary.trim() !== detail.summary ? { summary: draft.summary } : {}),
        ...(draft.brand.trim() !== splitBrands(detail.brand).join("，") ? { brand: draft.brand } : {}),
        ...(draft.category.trim() !== detail.category ? { category: draft.category } : {}),
        ...(identityChanged ? {
          eventIdentity: {
            subjects: nextSubjects,
            action: draft.eventAction,
            object: draft.eventObject,
          },
        } : {}),
        ...(draft.keyPoints.trim() !== parseJsonArray(detail.keyPoints).join("\n") ? {
          keyPoints: draft.keyPoints
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean),
        } : {}),
      });
      patchRow(updated);
      await refreshSelectedEvent(updated);
      refreshAfterMutation();
      setEditing(false);
      toast.success("人工纠错已保存");
    } catch (error) {
      toast.error(errorMessage(error, "保存失败"));
    } finally {
      setDetailAction(null);
    }
  };

  const handleDetailReview = useCallback(
    async (status: "important" | "general" | "irrelevant") => {
      if (
        !selectedId ||
        detailLoading ||
        detail?.id !== selectedId ||
        detailAction
      )
        return;
      setDetailAction("review");
      try {
        await reviewArticle(selectedId, status, reasonTags);
        const updated = await refreshArticleDetail(selectedId);
        await refreshSelectedEvent(updated);
        refreshAfterMutation();
        toast.success(`已归类为${reviewLabel(status)}`);
      } catch (error) {
        toast.error(errorMessage(error, "归类失败"));
      } finally {
        setDetailAction(null);
      }
    },
    [
      detail?.id,
      detailAction,
      detailLoading,
      reasonTags,
      refreshAfterMutation,
      refreshArticleDetail,
      refreshSelectedEvent,
      selectedId,
    ],
  );

  const startWorkflow = async (startAt: "process" | "ai") => {
    if (!detail || detailAction) return;
    const label =
      startAt === "process" ? "重新获取全文并重跑" : "重新生成 AI 结果";
    if (
      !window.confirm(
        startAt === "process"
          ? "当前 Event 归属和 AI 结果将被重置，并从全文获取开始连续重跑。确认继续吗？"
          : "将重新生成 AI 结果，人工覆盖字段会保留。确认继续吗？",
      )
    )
      return;
    setDetailAction("workflow");
    try {
      const result = await triggerArticleWorkflow(
        detail.id,
        startAt,
        "regenerate",
      );
      if (!result.queued) throw new Error(result.reason || "任务未能启动");
      refreshAfterMutation();
      toast.success(`${label}任务已启动，可在当前工作台查看进度`);
    } catch (error) {
      toast.error(errorMessage(error, `${label}失败`));
    } finally {
      setDetailAction(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName)
      )
        return;
      if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        void handleDetailReview("important");
      } else if (event.key.toLowerCase() === "g") {
        event.preventDefault();
        void handleDetailReview("general");
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        void handleDetailReview("irrelevant");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleDetailReview, open]);

  const manualOverridesValue = detail?.manualOverrides;
  const keyPointsValue = detail?.keyPoints;
  const brandValue = detail?.brand;
  const pushLogsValue = detail?.pushLogs;
  const cleanContentValue = detail?.cleanContent;
  const eventAuditsValue = eventDetail?.audits;
  const manualOverrides = useMemo(
    () => manualOverridesValue ? parseManualOverrides(manualOverridesValue) : [],
    [manualOverridesValue],
  );
  const keyPoints = useMemo(
    () => keyPointsValue ? parseJsonArray(keyPointsValue) : [],
    [keyPointsValue],
  );
  const brands = useMemo(
    () => brandValue ? splitBrands(brandValue) : [],
    [brandValue],
  );
  const latestPushLogs = useMemo(
    () => pushLogsValue ? latestPushTargetLogs(pushLogsValue) : [],
    [pushLogsValue],
  );
  const cleanContentText = useMemo(
    () => cleanContentValue ? stripHtml(cleanContentValue) : "",
    [cleanContentValue],
  );
  const currentEventAudits = useMemo(
    () => eventAuditsValue ?? [],
    [eventAuditsValue],
  );
  const eventMembers = useMemo(() => {
    const articles = eventDetail?.articles ?? [];
    return [...articles].sort((left, right) => {
      const leftRepresentative = left.id === eventDetail?.representativeArticleId;
      const rightRepresentative = right.id === eventDetail?.representativeArticleId;
      if (leftRepresentative !== rightRepresentative) return leftRepresentative ? -1 : 1;
      const leftTime = new Date(left.publishedAt || left.createdAt).getTime();
      const rightTime = new Date(right.publishedAt || right.createdAt).getTime();
      return rightTime - leftTime;
    });
  }, [eventDetail]);
  const brandCandidates = eventDetail?.brandCandidates ?? [];
  const eventSourceCount = new Set(eventMembers.map((article) => article.source.name)).size;
  const clickRate = detail && detail.viewCount > 0
    ? Math.round((detail.originalClickCount / detail.viewCount) * 100)
    : 0;
  const isRepresentative = Boolean(
    detail && detail.event?.representativeArticleId === detail.id,
  );
  const canForcePush = Boolean(
    detail &&
      eventDetail &&
      isRepresentative &&
      detail.clusterStatus === "clustered" &&
      detail.aiStatus === "done",
  );
  const clusterBlocked = detail?.clusterStatus === "needs_review";
  const pipelineFailed = Boolean(
    detail &&
      (detail.fetchStatus === "failed" ||
        detail.clusterStatus === "failed" ||
        detail.aiStatus === "failed"),
  );
  const decisionTitle = !detail
    ? "等待文章详情"
    : clusterBlocked
      ? "需先完成人工聚类复核"
      : pipelineFailed
        ? `${processingLabel(detail)}，需恢复流程`
        : detail.fetchStatus === "pending"
          ? "等待获取文章全文"
          : detail.aiStatus === "pending"
            ? "等待 AI 分析"
            : detail.aiStatus === "skipped"
              ? `AI 已跳过：${detail.skipReason || "未提供原因"}`
              : detail.clusterStatus === "pending"
                ? "等待归入 Event"
                : detail.reviewStatus === "unreviewed"
                  ? "内容待人工归类"
                  : !isRepresentative
                    ? "非代表文章，仅用于事件校准"
                    : detail.publicStatus === "published"
                      ? eventDetail?.pushedAt
                        ? "已公开并完成推送"
                        : "已公开，尚未推送"
                      : `当前未公开：${publicReasonLabel(detail.publicPublicationReason)}`;
  const decisionTone = clusterBlocked || pipelineFailed
    ? "border-amber-300 bg-amber-50 text-amber-950"
    : detail?.publicStatus === "published" && eventDetail?.pushedAt
      ? "border-emerald-300 bg-emerald-50 text-emerald-950"
      : "border-sky-300 bg-sky-50 text-sky-950";

  const detailWorkspace = detailLoading ? (
    <div className="space-y-2 p-3 lg:p-4">
      <Skeleton className="h-28 w-full rounded-none" />
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1.18fr)_minmax(360px,0.82fr)]">
        <Skeleton className="h-[520px] w-full rounded-none" />
        <Skeleton className="h-[520px] w-full rounded-none" />
      </div>
    </div>
  ) : detail ? (
    <ScrollArea className="h-full overscroll-contain">
      <div className="mx-auto w-full min-w-0 max-w-[960px] space-y-1 p-1 sm:p-1.5">
        <header className="min-w-0 overflow-hidden border bg-background">
          <div>
            <div className="min-w-0 p-2.5 pr-10">
              <div className="mt-1 flex flex-col gap-1">
                <div className="flex items-start justify-between gap-4">
                  <h1 className="min-w-0 flex-1 line-clamp-2 text-base font-semibold leading-5 text-balance sm:text-lg sm:leading-6">{detail.title}</h1>
                </div>
                {(brands.length > 0 || detail.category || detail.eventKey) && <div className="mt-2 overflow-x-auto border"><table className="min-w-[760px] w-full border-collapse text-xs"><tbody><tr className="border-b"><td className="w-[44px] whitespace-nowrap border-r bg-muted/30 px-1.5 py-1 text-muted-foreground">时间</td><td className="max-w-[160px] truncate border-r px-1.5 py-1 tabular-nums">{fullTimeLabel(detail.publishedAt ?? detail.createdAt)}</td><td className="w-[44px] whitespace-nowrap border-r bg-muted/30 px-1.5 py-1 text-muted-foreground">来源</td><td className="max-w-[160px] truncate border-r px-1.5 py-1" title={detail.source.name}>{detail.source.name}{detail.originalSource && detail.originalSource !== detail.source.name ? `（原始：${detail.originalSource}）` : ""}</td><td className="w-[44px] whitespace-nowrap border-r bg-muted/30 px-1.5 py-1 text-muted-foreground">状态</td><td className="max-w-[190px] truncate border-r px-1.5 py-1" title={`${processingLabel(detail)} · ${clusterLabel(detail)}`}>{processingLabel(detail)} · {clusterLabel(detail)}{isRepresentative ? " · 代表文章" : ""}{manualOverrides.length > 0 ? ` · 人工修正${manualOverrides.length}项` : ""}</td><td className="w-[44px] whitespace-nowrap border-r bg-muted/30 px-1.5 py-1 text-muted-foreground">品牌</td><td className="max-w-[140px] truncate px-1.5 py-1" title={brands.join("、")}>{brands.join("、") || "—"}</td></tr><tr className="border-b"><td className="w-[44px] whitespace-nowrap border-r bg-muted/30 px-1.5 py-1 text-muted-foreground">分类</td><td className="max-w-[160px] truncate border-r px-1.5 py-1" title={detail.category}>{detail.category || "—"}</td><td className="w-[44px] whitespace-nowrap border-r bg-muted/30 px-1.5 py-1 text-muted-foreground">事件键</td><td className="max-w-[190px] truncate border-r px-1.5 py-1 font-mono" title={`${detail.eventKey}${detail.eventKeyConfidence == null ? "" : `（${detail.eventKeyConfidence}%）`}`}>{detail.eventKey || "—"}</td><td className="w-[44px] whitespace-nowrap border-r bg-muted/30 px-1.5 py-1 text-muted-foreground">总分</td><td className="border-r px-1.5 py-1 font-semibold tabular-nums">{detail.score}</td><td className="w-[50px] whitespace-nowrap border-r bg-muted/30 px-1.5 py-1 text-muted-foreground">置信度</td><td className="px-1.5 py-1 tabular-nums">{detail.aiConfidence == null ? "—" : `${detail.aiConfidence}%`}</td></tr><tr className="border-b"><td className="w-[44px] whitespace-nowrap border-r bg-muted/30 px-1.5 py-1 text-muted-foreground">相关度</td><td className="border-r px-1.5 py-1 tabular-nums">{detail.relevance}</td><td className="w-[44px] whitespace-nowrap border-r bg-muted/30 px-1.5 py-1 text-muted-foreground">事件分</td><td className="border-r px-1.5 py-1 tabular-nums">{detail.eventScore ?? "—"}</td><td className="w-[44px] whitespace-nowrap border-r bg-muted/30 px-1.5 py-1 text-muted-foreground">内容分</td><td className="border-r px-1.5 py-1 tabular-nums">{detail.contentScore ?? "—"}</td><td className="w-[58px] whitespace-nowrap border-r bg-muted/30 px-1.5 py-1 text-muted-foreground">广告概率</td><td className="px-1.5 py-1 tabular-nums">{detail.adProbability == null ? "—" : `${detail.adProbability}%`}</td></tr><tr><td className="w-[44px] whitespace-nowrap border-r bg-muted/30 px-1.5 py-1 text-muted-foreground">内容</td><td className="px-1.5 py-1">{detail.isAd ? "软文" : "正常"}</td><td colSpan={6} /></tr></tbody></table></div>}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1 border-t pt-2">
                <Button size="sm" variant="outline" className={WORKSPACE_ACTION_CLASS} disabled={detailAction !== null} onClick={() => setEditing((value) => !value)}>{editing ? "取消编辑" : "人工编辑"}</Button>
                <a className={`inline-flex items-center border bg-background hover:bg-muted ${WORKSPACE_ACTION_CLASS}`} href={detail.url} target="_blank" rel="noreferrer">查看原文</a>
                <Button size="sm" variant="outline" className={WORKSPACE_ACTION_CLASS} disabled={detailAction !== null} onClick={() => void startWorkflow("ai")}>重新生成 AI</Button>
                <Button size="sm" variant="outline" className={WORKSPACE_ACTION_CLASS} disabled={detailAction !== null} onClick={() => void startWorkflow("process")}>重新抓取并全量重跑</Button>
                {isRepresentative && <Button size="sm" variant="outline" className={`${WORKSPACE_ACTION_CLASS} border-amber-500 text-amber-700 hover:bg-amber-50`} disabled={rowSavingId === detail.id} onClick={() => queueRowUpdate(detail.id, { publicOverride: detail.publicStatus === "published" ? "hidden" : "public" }, detail.publicStatus === "published" ? "已强制隐藏" : "已强制公开")}>{detail.publicStatus === "published" ? "强制隐藏" : "强制公开"}</Button>}
                {canForcePush && <Button size="sm" variant="outline" className={`${WORKSPACE_ACTION_CLASS} border-amber-500 text-amber-700 hover:bg-amber-50`} disabled={eventAction !== null} onClick={() => void pushCurrentEvent(eventDetail?.pushedAt ? "repush" : "manual")}>{eventDetail?.pushedAt ? "再次推送" : "强制推送"}</Button>}
              </div>
            </div>
          </div>
        </header>

        <div className="min-w-0 space-y-1">
          <main className="min-w-0 space-y-1">
            <section ref={contentPanelRef} className="min-w-0 scroll-mt-3 border bg-background">
              <div className="grid items-center gap-2 border-b px-2 py-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="flex min-w-0 items-center gap-2">
                  {keyPoints.length > 0 && <h3 className="text-xs font-semibold">核心要点</h3>}
                  <span className="ml-auto text-xs text-muted-foreground">{detail.aiStatus === "done" ? "分析完成" : processingLabel(detail)}</span>
                </div>
                <h2 className="text-xs font-semibold lg:border-l lg:pl-4">AI 洞察</h2>
              </div>
              <div className="min-w-0 grid gap-x-3 gap-y-1.5 p-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="min-w-0 max-w-full overflow-hidden">
                  {keyPoints.length > 0 ? <ol className="space-y-1 text-xs leading-5">{keyPoints.map((point, index) => <li key={`${point}-${index}`} className="grid min-w-0 grid-cols-[20px_minmax(0,1fr)] gap-1.5"><span className="font-mono text-xs font-semibold tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span><span className="min-w-0 break-all">{point}</span></li>)}</ol> : <p className="break-words text-xs leading-5 text-pretty text-muted-foreground">暂无要点</p>}
                </div>
                <div className="min-w-0 max-w-full overflow-hidden lg:border-l lg:pl-4">
                  <p className="max-h-[104px] max-w-full overflow-x-hidden overflow-y-auto whitespace-normal break-all pr-1 text-xs leading-5">{detail.summary || detail.excerpt || "暂无 AI 洞察"}</p>
                </div>
              </div>
            </section>

            {editing && <section className="grid gap-2 border bg-background p-3 sm:grid-cols-2"><label className="space-y-1 text-xs">品牌<Input className="h-8 rounded-none text-xs" value={draft.brand} onChange={(event) => setDraft((value) => ({ ...value, brand: event.target.value }))} /></label><label className="space-y-1 text-xs">分类<Input className="h-8 rounded-none text-xs" value={draft.category} onChange={(event) => setDraft((value) => ({ ...value, category: event.target.value }))} /></label><label className="space-y-1 text-xs">事件主体（多个主体用逗号分隔）<Input className="h-8 rounded-none text-xs" value={draft.eventSubjects} onChange={(event) => setDraft((value) => ({ ...value, eventSubjects: event.target.value }))} /></label><label className="space-y-1 text-xs">事件行为（保留计划/正式/完成等阶段）<Input className="h-8 rounded-none text-xs" value={draft.eventAction} onChange={(event) => setDraft((value) => ({ ...value, eventAction: event.target.value }))} /></label><label className="space-y-1 text-xs sm:col-span-2">具体事项<Input className="h-8 rounded-none text-xs" value={draft.eventObject} onChange={(event) => setDraft((value) => ({ ...value, eventObject: event.target.value }))} /></label><label className="space-y-1 text-xs sm:col-span-2">AI 洞察<Textarea value={draft.summary} onChange={(event) => setDraft((value) => ({ ...value, summary: event.target.value }))} className="min-h-24 rounded-none text-xs" /></label><label className="space-y-1 text-xs sm:col-span-2">核心要点（每行一条）<Textarea value={draft.keyPoints} onChange={(event) => setDraft((value) => ({ ...value, keyPoints: event.target.value }))} className="min-h-24 rounded-none text-xs" /></label><Button size="sm" className="h-8 rounded-none text-xs sm:col-span-2" disabled={detailAction !== null} onClick={() => void saveEditorial()}>{detailAction === "edit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存人工修正</Button></section>}

          </main>

          <aside className="min-w-0 space-y-1">
            <section className="border bg-background">
              <SectionHeader title="公开与人工判断" meta={detail.reviewedAt ? `审核于 ${fullTimeLabel(detail.reviewedAt)}` : "尚未审核"} />
              <div className="space-y-1 p-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="text-muted-foreground">公开策略</span>
                  <select aria-label="人工公开策略" disabled={rowSavingId === detail.id} value={detail.publicOverride} onChange={(event) => queueRowUpdate(detail.id, { publicOverride: event.target.value as "auto" | "public" | "hidden" }, "公开策略已更新")} className="h-7 rounded-none border bg-background px-1.5 text-xs"><option value="auto">自动</option><option value="public">强制公开</option><option value="hidden">强制隐藏</option></select>
                  <span className="text-muted-foreground">结果</span>
                  <span className={`font-medium ${detail.publicStatus === "published" ? "text-emerald-700" : "text-amber-700"}`}>{publicResultLabel(detail)}</span>
                  <span className="text-muted-foreground">· {detail.publicStatus === "published" ? "已通过当前公开规则" : publicReasonLabel(detail.publicPublicationReason)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="text-muted-foreground">归类</span>
                  {REASONS.map(([value, label]) => <label key={value} className="inline-flex cursor-pointer items-center gap-1"><input type="checkbox" checked={reasonTags.includes(value)} onChange={(event) => setReasonTags((prev) => event.target.checked ? [...prev, value] : prev.filter((item) => item !== value))} />{label}</label>)}
                  <span className="text-muted-foreground ml-2">判断</span>
                  <Button size="sm" className="h-6 rounded-none bg-emerald-700 px-1.5 text-xs hover:bg-emerald-800" disabled={detailAction !== null} onClick={() => void handleDetailReview("important")}>{detailAction === "review" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}重要</Button>
                  <Button size="sm" variant="outline" className="h-6 rounded-none px-1.5 text-xs" disabled={detailAction !== null} onClick={() => void handleDetailReview("general")}>一般</Button>
                  <Button size="sm" variant="outline" className="h-6 rounded-none px-1.5 text-xs text-muted-foreground" disabled={detailAction !== null} onClick={() => void handleDetailReview("irrelevant")}>无关</Button>
                </div>
              </div>
            </section>

            {eventDetail && (
              <section ref={clusterPanelRef} className="min-w-0 scroll-mt-3 bg-background">
                <SectionHeader title="Event 校准" meta={`${eventDetail.articleCount} 篇 · ${eventSourceCount} 个来源`} />
                <div className="space-y-1.5 p-2">

                  {detail.clusterStatus === "needs_review" && <div className="grid gap-1.5 border border-amber-300 bg-amber-50 p-2"><p className="text-xs font-medium text-amber-950">当前聚类存在歧义。完成复核前，本篇不能成为代表、公开或推送。</p><div className="flex flex-wrap gap-1"><Button size="sm" className="h-7 rounded-none px-1.5 text-xs" disabled={eventAction !== null} onClick={() => void confirmIndependent()}>确认独立事件</Button>{recommendedEventId && <Button size="sm" variant="outline" className="h-7 rounded-none px-1.5 text-xs" disabled={eventAction !== null} onClick={() => void moveCurrentArticle(recommendedEventId)}>并入系统推荐 Event</Button>}</div></div>}

                  <div className="pt-1">
                    <div className="mb-1.5 flex items-center gap-2">
                      <div><p className="text-xs font-semibold">事件成员对比</p><p className="text-xs text-muted-foreground">勾选成员可批量拆分；至少保留一篇在当前 Event。</p></div>
                      {selectedSplitIds.size > 0 && <Button size="sm" variant="outline" className="ml-auto h-7 rounded-none px-1.5 text-xs text-amber-700" disabled={eventAction !== null} onClick={() => void splitArticles([...selectedSplitIds])}><Split className="h-3 w-3" />拆分所选 {selectedSplitIds.size} 篇</Button>}
                    </div>
                    <div className="min-w-0 max-w-full max-h-[320px] overflow-x-scroll overflow-y-auto overscroll-contain border">
                      <table className="w-max min-w-[1120px] table-auto border-collapse text-xs">
                        <thead className="sticky top-0 z-[1] bg-muted/60 text-muted-foreground">
                          <tr>
                            <th className="sticky left-0 z-[3] w-[52px] border-b border-r bg-muted px-1 py-1 text-center font-medium">序号</th>
                            <th className="w-[1%] whitespace-nowrap border-b border-r bg-muted px-2 py-1 text-left font-medium">发布时间</th>
                            <th className="sticky left-[52px] z-[3] min-w-[220px] max-w-[360px] border-b border-r bg-muted px-2 py-1 text-left font-medium">标题</th>
                            <th className="border-b border-r px-1 py-1 text-center font-medium">代表</th>
                            <th className="border-b border-r px-2 py-1 text-left font-medium">品牌</th>
                            <th className="border-b border-r px-2 py-1 text-left font-medium">事件键</th>
                            <th className="border-b border-r px-1 py-1 text-center font-medium">总分</th>
                            <th className="border-b border-r px-1 py-1 text-center font-medium">审核</th>
                            <th className="border-b border-r px-2 py-1 text-left font-medium">来源</th>
                            <th className="border-b border-r px-2 py-1 text-left font-medium">状态</th>
                            <th className="border-b border-r px-2 py-1 text-left font-medium">公开</th>
                            <th className="border-b border-r px-2 py-1 text-left font-medium">推送</th>
                            <th className="sticky right-0 z-[3] border-b bg-muted px-2 py-1 text-left font-medium">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {eventMembers.map((article, index) => {
                            const representative = eventDetail.representativeArticleId === article.id;
                            const selected = selectedSplitIds.has(article.id);
                            const sourceStatus = article.source.deleted
                              ? "已删除"
                              : article.source.publicEnabled
                                ? "可公开"
                                : "不公开";
                            const rowBackground = article.id === detail.id
                              ? "bg-sky-50"
                              : selected
                                ? "bg-amber-50"
                                : representative
                                  ? "bg-emerald-50/60"
                                  : "bg-background group-hover:bg-muted/20";
                            const stickyRowBackground = article.id === detail.id
                              ? "bg-sky-50"
                              : selected
                                ? "bg-amber-50"
                                : representative
                                  ? "bg-emerald-50"
                                  : "bg-background group-hover:bg-muted";
                            return (
                              <tr key={article.id} className={`group whitespace-nowrap border-b last:border-b-0 ${rowBackground}`}>
                                <td className={`sticky left-0 z-[2] border-r px-1 py-1.5 align-middle ${stickyRowBackground}`}><div className="flex items-center justify-center gap-1"><input type="checkbox" aria-label={`选择拆分 ${article.title}`} checked={selected} disabled={eventDetail.articleCount <= 1 || eventAction !== null} onChange={() => toggleSplitSelection(article.id)} /><span className="tabular-nums text-muted-foreground">{index + 1}</span></div></td>
                                <td className="w-[1%] whitespace-nowrap border-r px-2 py-1.5 font-mono tabular-nums align-middle text-muted-foreground">{timeLabel(article.publishedAt || article.createdAt)}</td>
                                <td className={`sticky left-[52px] z-[2] min-w-[220px] border-r px-2 py-1.5 align-middle ${stickyRowBackground}`}><button type="button" onClick={() => selectArticle(article.id, "cluster")} className="block max-w-[360px] truncate text-left font-medium hover:underline" title={article.title}>{article.title}</button></td>
                                <td className="border-r px-1 py-1.5 text-center align-middle">{representative ? <span className="bg-foreground px-1.5 py-0.5 max-w-[160px] text-background">代表</span> : "—"}</td>
                                <td className="border-r px-2 py-1.5 align-middle text-muted-foreground" title={article.brand ? splitBrands(article.brand).join(" / ") : "无"}><div className="max-w-[160px] truncate">{article.brand ? splitBrands(article.brand).join(" / ") : "—"}</div></td>
                                <td className="border-r px-2 py-1.5 font-mono align-middle text-muted-foreground" title={article.eventKey || "未生成"}><div className="max-w-[260px] truncate">{article.eventKey || "—"}</div></td>
                                <td className="border-r px-1 py-1.5 text-center font-semibold tabular-nums align-middle">{article.score}</td>
                                <td className={`border-r px-1 py-1.5 text-center align-middle ${article.reviewStatus === "unreviewed" ? "text-red-700" : "text-muted-foreground"}`}>{reviewLabel(article.reviewStatus)}</td>
                                <td className="border-r px-2 py-1.5 align-middle" title={article.source.name}><div className="max-w-[180px] truncate">{article.source.name}</div></td>
                                <td className={`border-r px-2 py-1.5 align-middle ${article.source.deleted ? "text-red-700" : article.source.publicEnabled ? "text-emerald-700" : "text-muted-foreground"}`}>{sourceStatus}</td>
                                <td className={`border-r px-2 py-1.5 align-middle ${article.publicStatus === "published" ? "text-emerald-700" : "text-muted-foreground"}`}>{article.publicStatus === "published" ? "已公开" : "未公开"}</td>
                                <td className={`border-r px-2 py-1.5 align-middle ${article.pushStatus === "success" ? "text-emerald-700" : article.pushStatus === "failure" ? "text-red-700" : article.pushStatus === "partial" ? "text-amber-700" : "text-muted-foreground"}`}>{articlePushStatusLabel(article.pushStatus)}</td>
                                <td className={`sticky right-0 z-[2] px-1 py-1 align-middle ${stickyRowBackground}`}><div className="flex items-center gap-1 whitespace-nowrap">{!representative && <Button size="sm" variant="ghost" className="h-6 rounded-none px-1.5 text-xs" disabled={eventAction !== null || article.clusterStatus !== "clustered" || article.aiStatus !== "done" || article.source.deleted} onClick={() => void setRepresentative(article.id)}>设为代表</Button>}{!representative && eventDetail.articleCount > 1 && <Button size="sm" variant="ghost" className="h-6 rounded-none px-1.5 text-xs text-amber-700" disabled={eventAction !== null} onClick={() => void splitArticle(article.id)}>单独拆分</Button>}</div></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-2 pt-2">
                      <div className="mb-1.5 flex items-center gap-2">
                        <div>
                          <p className="text-xs font-semibold">同品牌候选</p>
                          <p className="text-xs text-muted-foreground">{brands.length > 0 ? `基于 ${brands.join("、")}，最近 30 天` : "当前文章未识别品牌"}</p>
                        </div>
                        {brands.length > 0 && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{brandCandidates.length} 篇</span>}
                      </div>
                      {brands.length === 0 ? (
                        <p className="border border-dashed px-2.5 py-2 text-xs text-muted-foreground">补充品牌后，系统会自动召回同品牌文章。</p>
                      ) : brandCandidates.length === 0 ? (
                        <p className="border border-dashed px-2.5 py-2 text-xs text-muted-foreground">最近 30 天没有未归入当前 Event 的同品牌文章。</p>
                      ) : (
                        <div className="max-h-[280px] divide-y overflow-auto border border-amber-200 bg-amber-50/30">
                          {brandCandidates.map((candidate) => (
                            <div key={candidate.id} className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-xs">
                              <div className="min-w-0 flex-1">
                                <button type="button" onClick={() => selectArticle(candidate.id, "cluster")} className="block max-w-full truncate text-left font-medium hover:underline" title={candidate.title}>{candidate.title}</button>
                                <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-muted-foreground">
                                  <span>{candidate.matchedBrands.join("、")}</span>
                                  <span>{candidate.source.name}</span>
                                  <span>{timeLabel(candidate.publishedAt || candidate.createdAt)}</span>
                                  <span>{candidate.score} 分</span>
                                </div>
                              </div>
                              <Button size="sm" variant="outline" className="h-6 shrink-0 rounded-none border-amber-400 px-1.5 text-xs text-amber-800 hover:bg-amber-100" disabled={eventAction !== null} onClick={() => void moveBrandCandidate(candidate)}>移入 Event</Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <details open><summary className="flex cursor-pointer items-center justify-between border-t py-1.5 text-xs font-semibold"><span>聚类记录</span><span className="font-normal text-muted-foreground">{currentEventAudits.length} 条</span></summary><div className="max-h-[260px] overflow-y-auto"><div className="divide-y">{currentEventAudits.slice(0, 8).map((audit) => { const reason = clusterAuditReason(audit); return <div key={audit.id} className={`flex gap-2 border-l-2 px-2.5 py-2 text-xs leading-4 ${audit.actor === "admin" ? "border-sky-400" : "border-muted-foreground/30"}`}><div className="min-w-0 flex-1"><p className="flex flex-wrap items-center gap-x-2 gap-y-0.5"><span className="font-medium">{clusterAuditActionLabel(audit.action)}</span><span className="text-muted-foreground">{audit.actor === "admin" ? "人工" : "系统"}</span>{audit.confidence != null && <span className="text-muted-foreground">置信度 {audit.confidence}%</span>}<time className="text-muted-foreground">{fullTimeLabel(audit.createdAt)}</time></p>{reason && <p className="mt-0.5 text-muted-foreground">{reason}</p>}{audit.candidateEvent?.representativeArticle?.title && <p className="mt-0.5 truncate text-muted-foreground" title={audit.candidateEvent.representativeArticle.title}>关联：{audit.candidateEvent.representativeArticle.title}</p>}</div></div>; })}{currentEventAudits.length === 0 && <p className="px-2.5 py-2 text-xs text-muted-foreground">暂无聚类记录</p>}</div></div></details>

                  <details open><summary className="flex cursor-pointer items-center justify-between border-t py-1.5 text-xs font-semibold"><span>调整事件归属</span><span className="font-normal text-muted-foreground">移动当前文章或合并整组</span></summary><div className="space-y-2 p-2"><div className="flex gap-1"><Input value={eventSearch} onChange={(event) => setEventSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchEvents(); }} placeholder="搜索标题、品牌或事件键" className="h-7 rounded-none text-xs" /><Button size="sm" variant="outline" className="h-7 shrink-0 rounded-none px-1.5 text-xs" onClick={() => void searchEvents()}><Search className="h-3 w-3" />搜索</Button></div><button type="button" className="text-xs text-muted-foreground hover:text-foreground pb-0.5" onClick={() => { const query = detail.title.slice(0, 30); setEventSearch(query); void searchEvents(query); }}>用当前标题搜索相似事件</button>{eventOptions.length > 0 ? <div className="max-h-56 divide-y overflow-y-auto border">{eventOptions.map((event) => <div key={event.id} className={`p-2 text-xs ${mergeTargetId === event.id ? "bg-sky-50" : ""}`}><p className="line-clamp-2 font-medium">{event.representativeArticle?.title || `Event ${event.id.slice(-8)}`}</p><div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-muted-foreground"><span>{event.articleCount} 篇</span><span>{event.representativeArticle?.source.name || "未知来源"}</span><span>{event.publicStatus === "published" ? "已公开" : "未公开"}</span><span>{event.pushedAt ? "已推送" : "未推送"}</span><span>{fullTimeLabel(event.lastSeenAt)}</span></div><div className="mt-1 flex gap-1"><Button size="sm" variant="outline" className="h-7 rounded-none px-1 text-xs" disabled={eventAction !== null} onClick={() => void moveCurrentArticle(event.id)}>仅移动当前文章</Button><Button size="sm" variant="ghost" className="h-7 rounded-none px-1 text-xs" disabled={eventAction !== null} onClick={() => setMergeTargetId(event.id)}>选为整组目标</Button></div></div>)}</div> : <p className="border border-dashed px-2.5 py-2 text-xs text-muted-foreground">{eventSearch.trim() ? "未找到匹配的目标 Event。" : "输入关键词搜索目标 Event。"}</p>}{mergeTargetId && <div className="flex items-center gap-2 border bg-sky-50 px-2 py-1.5 text-xs"><span className="min-w-0 flex-1 truncate">整组目标：{eventOptions.find((event) => event.id === mergeTargetId)?.representativeArticle?.title || mergeTargetId}</span><Button size="sm" variant="ghost" className="h-6 shrink-0 rounded-none px-1.5 text-xs" disabled={eventAction !== null} onClick={() => setMergeTargetId("")}>取消</Button><Button size="sm" variant="outline" className="h-6 shrink-0 rounded-none px-1.5 text-xs text-amber-700" disabled={eventAction !== null} onClick={() => void mergeCurrentEvent()}><Merge className="h-3 w-3" />整组并入</Button></div>}</div></details>
                </div>
              </section>
            )}

            <section className="bg-background"><SectionHeader title="文章全貌" meta={`Article ${detail.id.slice(-8)}`} /><div className="grid grid-cols-2 divide-x border-b"><div className="p-2"><div className="flex items-center gap-1.5"><Eye className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /><span className="text-xs text-muted-foreground">公开浏览</span></div><p className="mt-0.5 font-mono text-xs font-semibold tabular-nums">{detail.viewCount.toLocaleString("zh-CN")}</p></div><div className="p-2"><div className="flex items-center gap-1.5"><MousePointerClick className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /><span className="text-xs text-muted-foreground">原文点击 · {clickRate}%</span></div><p className="mt-0.5 font-mono text-xs font-semibold tabular-nums">{detail.originalClickCount.toLocaleString("zh-CN")}</p></div></div><div className="grid gap-x-3 gap-y-1 p-2.5 text-xs sm:grid-cols-2 lg:grid-cols-3"><MetaRow label="详情处理" value={stageStatusLabel("fetch", detail.fetchStatus)} /><MetaRow label="AI 分析" value={stageStatusLabel("ai", detail.aiStatus)} /><MetaRow label="事件聚类" value={stageStatusLabel("cluster", detail.clusterStatus)} />{detail.skipReason && <MetaRow label="跳过原因" value={detail.skipReason} />}{detail.pinUntil && <MetaRow label="置顶截止" value={fullTimeLabel(detail.pinUntil)} />}<MetaRow label="原始评分" value={detail.rawScore == null ? "—" : String(detail.rawScore)} mono /><MetaRow label="创建时间" value={fullTimeLabel(detail.createdAt)} /><MetaRow label="更新时间" value={fullTimeLabel(detail.updatedAt)} /><MetaRow label="发布时间" value={fullTimeLabel(detail.publishedAt)} /><MetaRow label="聚类时间" value={fullTimeLabel(detail.clusteredAt)} /><MetaRow label="人工修正" value={detail.manualCorrectedAt ? fullTimeLabel(detail.manualCorrectedAt) : "无"} /><MetaRow label="来源类型" value={detail.source.type} /><div className="min-w-0 sm:col-span-2 lg:col-span-3"><MetaRow label="文章 ID" value={detail.id} mono /></div><div className="min-w-0 sm:col-span-2 lg:col-span-3"><div className="grid min-w-0 grid-cols-[58px_minmax(0,1fr)] gap-2"><span className="text-muted-foreground">来源主页</span><a className="min-w-0 truncate underline-offset-2 hover:underline" href={detail.source.url} target="_blank" rel="noreferrer" title={detail.source.url}>{detail.source.url}</a></div></div></div>{manualOverrides.length > 0 && <div className="border-t p-2.5"><p className="text-xs font-medium text-muted-foreground">人工覆盖字段</p><div className="mt-1.5 flex flex-wrap gap-1">{manualOverrides.map((field) => <Badge key={field} variant="secondary" className="h-5 rounded-none px-1 text-xs">{manualFieldLabel(field)}</Badge>)}</div></div>}</section>
          </aside>

          <section className="bg-background">
            <button type="button" className="flex w-full items-center justify-between px-2 py-1.5 text-left text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px]" onClick={() => { setShowFullContent((value) => !value); setRequestedPanel("content"); updateDetailUrl(detail.id, "content"); }}><span className="flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" aria-hidden="true" />正文核验 <span className="font-normal text-muted-foreground">{cleanContentText.length.toLocaleString("zh-CN")} 字</span></span><ChevronDown className={`h-3.5 w-3.5 transition-transform ${showFullContent ? "rotate-180" : ""}`} aria-hidden="true" /></button>
            {showFullContent && <div className="max-h-[220px] overflow-y-auto border-t px-2 py-1.5 text-xs leading-4 break-words whitespace-pre-line text-pretty">{cleanContentText.slice(0, 12000) || "正文尚未准备好"}</div>}
          </section>

          {detail.pushLogs.length > 0 && <section className="bg-background"><SectionHeader title="推送记录" meta={`${latestPushLogs.length} 个目标 · ${detail.pushLogs.length} 条记录`} /><div className="divide-y">{detail.pushLogs.map((log) => <div key={log.id} className="grid gap-0.5 px-3 py-2 text-xs sm:grid-cols-[100px_minmax(0,1fr)_68px_116px] sm:items-center sm:gap-2"><span className={`font-medium ${log.status === "success" ? "text-emerald-700" : log.status === "failed" || log.status === "failure" ? "text-red-700" : "text-amber-700"}`}>{pushStatusLabel(log.status)}{log.retryCount > 0 ? ` · 重试 ${log.retryCount}` : ""}</span><span className="min-w-0 truncate" title={log.webhookTarget}>{log.webhookRemark || log.webhookTarget || "未命名目标"}</span><span className="text-muted-foreground">{log.articleId === detail.id ? "本篇代表" : "历史代表"}</span><span className="font-mono text-xs tabular-nums text-muted-foreground sm:text-right">{fullTimeLabel(log.createdAt)}</span>{log.errorMessage && <p className="text-red-700 sm:col-span-4">{log.errorMessage}</p>}</div>)}</div></section>}
        </div>
      </div>
    </ScrollArea>
  ) : <div className="flex h-full items-center justify-center text-xs text-muted-foreground">文章不存在或尚未选择</div>;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 [&>[data-slot=sheet-close]]:z-10 [&>[data-slot=sheet-close]]:rounded-none [&>[data-slot=sheet-close]]:bg-background sm:max-w-[min(987px,65dvw)]">
        <SheetHeader className="sr-only">
          <SheetTitle>文章工作台</SheetTitle>
          <SheetDescription>内容校准、Event 修正、公开与推送</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 bg-muted/10">{detailWorkspace}</div>
      </SheetContent>
    </Sheet>
  );
}

function SectionHeader({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex min-h-7 items-center gap-2 border-b px-2 py-1">
      <h2 className="text-xs font-semibold">{title}</h2>
      {meta && <span className="ml-auto text-xs text-muted-foreground">{meta}</span>}
    </div>
  );
}

function MetaRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[74px_minmax(0,1fr)] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={`min-w-0 break-words ${mono ? "font-mono text-xs tabular-nums" : ""}`} title={value}>{value}</span>
    </div>
  );
}

function ScoreEditor({
  label,
  ...props
}: {
  label: string;
  item: ArticleListItemDto;
  field: NumericField;
  value: number | null;
  saving: boolean;
  onUpdate: (
    id: string,
    input: Parameters<typeof updateArticleEditorial>[1],
    message: string,
  ) => void;
}) {
  return (
    <div className="border-b border-r p-1.5 text-center">
      <p className="text-muted-foreground">{label}</p>
      <NumericCell {...props} />
    </div>
  );
}

function NumericCell({
  item,
  field,
  value,
  saving,
  onUpdate,
  suffix = "",
}: {
  item: ArticleListItemDto;
  field: NumericField;
  value: number | null;
  saving: boolean;
  onUpdate: (
    id: string,
    input: Parameters<typeof updateArticleEditorial>[1],
    message: string,
  ) => void;
  suffix?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  const overridden = parseManualOverrides(item.manualOverrides).includes(field);
  const aiValue = getSnapshotValue(item.aiSnapshot, field);
  useEffect(() => {
    if (!editing) setDraft(value == null ? "" : String(value));
  }, [editing, value]);
  const save = () => {
    const next = Number(draft);
    if (!Number.isFinite(next) || next < 0 || next > 100) {
      toast.error("请输入 0-100 的数值");
      setDraft(value == null ? "" : String(value));
      return;
    }
    setEditing(false);
    if (next !== value) onUpdate(item.id, { [field]: next }, "人工评分已更新");
  };
  if (editing)
    return (
      <Input
        autoFocus
        aria-label={`编辑${field}`}
        disabled={saving}
        value={draft}
        type="number"
        min={0}
        max={100}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setEditing(false);
            setDraft(value == null ? "" : String(value));
          }
        }}
        className="mt-1 h-7 min-w-0 rounded-none px-0 text-center text-xs"
      />
    );
  return (
    <div className="group relative mt-1 flex h-7 items-center justify-center">
      <button
        type="button"
        disabled={saving}
        onClick={(event) => {
          event.stopPropagation();
          setEditing(true);
        }}
        className={`h-7 w-full text-center text-xs tabular-nums hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] ${overridden ? "font-semibold text-violet-700" : "font-medium"}`}
        title={
          overridden
            ? `AI 原值 ${String(aiValue ?? "暂无")}，点击编辑`
            : "点击人工修正"
        }
      >
        {value == null ? "—" : `${value}${suffix}`}
      </button>
      {overridden && aiValue !== undefined && (
        <button
          type="button"
          disabled={saving}
          aria-label={`恢复${field}的AI原值`}
          title={`恢复 AI 原值 ${String(aiValue)}`}
          onClick={(event) => {
            event.stopPropagation();
            onUpdate(item.id, { restoreFields: [field] }, "已恢复 AI 原值");
          }}
          className="absolute right-0 hidden bg-background text-violet-700 group-hover:block group-focus-within:block"
        >
          <Undo2 className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}
