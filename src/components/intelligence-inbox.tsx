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
  parseTags,
  splitBrands,
  stripHtml,
} from "@/lib/shared/article-codecs";

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
    score: number;
    relevance: number;
    eventScore: number | null;
    contentScore: number | null;
    aiConfidence: number | null;
    aiStatus: string;
    publicStatus: string;
    publicOverride: string;
    isAd: boolean;
    brand: string;
    category: string;
    reviewStatus: string;
    clusterStatus: string;
    publishedAt: string | null;
    createdAt: string;
    source: { name: string; type: string; publicEnabled: boolean; deleted: boolean };
  }>;
};

const REASONS = [
  ["low_score", "评分偏低"],
  ["ad_misclassification", "误判软文"],
  ["wrong_brand", "品牌错误"],
  ["keyword_ambiguity", "关键词歧义"],
  ["poor_summary", "摘要较差"],
] as const;

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
  if (item.clusterStatus === "failed") return "聚类失败";
  if (item.clusterStatus === "needs_review") return "聚类复核";
  if (item.fetchStatus === "failed") return "抓取失败";
  if (item.fetchStatus === "pending" && item.aiStatus !== "done")
    return "待抓取";
  if (item.aiStatus === "failed") return "AI失败";
  if (item.aiStatus === "skipped" && item.skipReason?.includes("内容不足"))
    return "正文不足";
  if (item.aiStatus === "skipped") return "已跳过";
  if (item.aiStatus === "pending") return "分析中";
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
      tags: "标签",
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
  const [clusterAuditOpen, setClusterAuditOpen] = useState(false);
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
    tags: "",
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
    setClusterAuditOpen(initialPanelRef.current === "cluster");
  }, [articleId]);

  useEffect(() => {
    setRequestedPanel(initialPanel);
    setClusterAuditOpen(initialPanel === "cluster");
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
          tags: parseTags(result.tags)
            .map((tag) => tag.name)
            .join("，"),
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
    if (requestedPanel === "cluster") setClusterAuditOpen(true);
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
        const response = await fetch(
          `/api/events/${encodeURIComponent(eventId)}`,
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
    [],
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
  }, [detail?.eventId, loadEventDetail]);

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
    setDetailAction("edit");
    try {
      const updated = await updateArticleEditorial(selectedId, {
        summary: draft.summary,
        brand: draft.brand,
        category: draft.category,
        tags: draft.tags
          .split(/[,，\n]/)
          .map((name) => ({ name: name.trim(), tone: "中" }))
          .filter((tag) => tag.name),
        keyPoints: draft.keyPoints
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
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
  const tagsValue = detail?.tags;
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
  const tags = useMemo(
    () => tagsValue ? parseTags(tagsValue) : [],
    [tagsValue],
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
  const eventMembers = eventDetail?.articles ?? [];
  const representativeMember = eventMembers.find((article) => article.id === eventDetail?.representativeArticleId) ?? null;
  const eventSourceCount = new Set(eventMembers.map((article) => article.source.name)).size;
  const eventScoreRange = eventMembers.length > 0
    ? `${Math.min(...eventMembers.map((article) => article.score))}–${Math.max(...eventMembers.map((article) => article.score))}`
    : "—";
  const eventReviewCount = eventMembers.filter((article) => article.clusterStatus === "needs_review" || article.reviewStatus === "unreviewed").length;
  const eventBlockedCount = eventMembers.filter((article) => article.aiStatus !== "done" || article.clusterStatus !== "clustered" || article.source.deleted).length;
  const eventPublicCandidateCount = eventMembers.filter((article) => article.aiStatus === "done" && article.clusterStatus === "clustered" && article.source.publicEnabled && !article.source.deleted).length;
  const eventSpanDays = eventDetail
    ? Math.max(1, Math.ceil((new Date(eventDetail.lastSeenAt).getTime() - new Date(eventDetail.firstSeenAt).getTime()) / 86_400_000) + 1)
    : 0;
  const successfulPushTargets = latestPushLogs.filter(
    (log) => log.status === "success",
  ).length;
  const failedPushTargets = latestPushLogs.filter(
    (log) => log.status !== "success",
  ).length;
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
          : detail.clusterStatus === "pending"
            ? "等待归入 Event"
            : detail.aiStatus === "pending"
              ? "等待 AI 分析"
              : detail.aiStatus === "skipped"
                ? `AI 已跳过：${detail.skipReason || "未提供原因"}`
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
    <div className="space-y-3 p-4 lg:p-5">
      <Skeleton className="h-28 w-full rounded-none" />
      <div className="grid gap-3 lg:grid-cols-[minmax(380px,0.82fr)_minmax(520px,1.18fr)]">
        <Skeleton className="h-[520px] w-full rounded-none" />
        <Skeleton className="h-[520px] w-full rounded-none" />
      </div>
    </div>
  ) : detail ? (
    <ScrollArea className="h-full overscroll-contain">
      <div className="mx-auto max-w-[1240px] space-y-2 p-2 sm:p-3">
        <header className="border bg-background">
          <div className="grid lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 p-3 pr-12">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                <span>{fullTimeLabel(detail.publishedAt ?? detail.createdAt)}</span>
                <span aria-hidden="true">·</span>
                <span>{detail.source.name}</span>
                {detail.originalSource && detail.originalSource !== detail.source.name && <><span aria-hidden="true">·</span><span>原始来源：{detail.originalSource}</span></>}
                <Badge variant="outline" className="h-5 rounded-none px-1.5">{processingLabel(detail)}</Badge>
                <Badge variant="outline" className="h-5 rounded-none px-1.5">{clusterLabel(detail)}</Badge>
                {isRepresentative && <Badge className="h-5 rounded-none bg-foreground px-1.5 text-background">代表文章</Badge>}
                {manualOverrides.length > 0 && <Badge variant="secondary" className="h-5 rounded-none px-1.5">人工修正 {manualOverrides.length} 项</Badge>}
              </div>
              <h1 className="mt-1.5 max-w-4xl text-lg font-semibold leading-7 text-balance sm:text-xl">{detail.title}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="outline" className="h-7 rounded-none px-2 text-xs" disabled={detailAction !== null} onClick={() => setEditing((value) => !value)}>{editing ? "取消编辑" : "人工编辑"}</Button>
                <a className="inline-flex h-7 items-center gap-1 border px-2 text-xs font-medium hover:bg-muted" href={detail.url} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />查看原文</a>
                <Button size="sm" variant="outline" className="h-7 rounded-none px-2 text-xs" disabled={detailAction !== null} onClick={() => void startWorkflow("ai")}><RefreshCcw className="h-3.5 w-3.5" />重新生成 AI</Button>
                <Button size="sm" variant="ghost" className="h-7 rounded-none px-2 text-xs" disabled={detailAction !== null} onClick={() => void startWorkflow("process")}>重新抓取并全量重跑</Button>
                {eventDetail && <Button size="sm" variant="outline" className="h-7 rounded-none px-2 text-xs" onClick={() => { setRequestedPanel("cluster"); setClusterAuditOpen(true); updateDetailUrl(detail.id, "cluster"); requestAnimationFrame(() => clusterPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })); }}>修正归类</Button>}
                {isRepresentative && <Button size="sm" variant="outline" className="h-7 rounded-none px-2 text-xs" disabled={rowSavingId === detail.id} onClick={() => queueRowUpdate(detail.id, { publicOverride: detail.publicStatus === "published" ? "hidden" : "public" }, detail.publicStatus === "published" ? "已强制隐藏" : "已强制公开")}>{detail.publicStatus === "published" ? "强制隐藏" : "强制公开"}</Button>}
                {canForcePush && <Button size="sm" className="h-7 rounded-none bg-amber-600 px-2 text-xs text-white hover:bg-amber-700" disabled={eventAction !== null} onClick={() => void pushCurrentEvent(eventDetail?.pushedAt ? "repush" : "manual")}><Send className="h-3.5 w-3.5" />{eventDetail?.pushedAt ? "再次推送" : "强制推送"}</Button>}
              </div>
            </div>
            <div className={`border-t p-3 lg:border-l lg:border-t-0 lg:pr-12 ${decisionTone}`}>
              <div className="flex items-start gap-2">
                {clusterBlocked || pipelineFailed ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
                <div className="min-w-0"><p className="text-[11px] font-medium opacity-70">当前结论</p><p className="mt-1 text-sm font-semibold leading-5">{decisionTitle}</p><p className="mt-2 text-[11px] leading-5 opacity-75">{isRepresentative ? "本篇承担 Event 对外展示与推送。" : "Event 只允许代表文章对外展示与推送。"}</p></div>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 border-t text-xs sm:grid-cols-3 lg:grid-cols-6">
            <MetricCell label="最终总分" value={String(detail.score)} strong />
            <MetricCell label="AI 置信度" value={detail.aiConfidence == null ? "—" : `${detail.aiConfidence}%`} />
            <MetricCell label="人工归类" value={reviewLabel(detail.reviewStatus)} warning={detail.reviewStatus === "unreviewed"} />
            <MetricCell label="公开状态" value={publicResultLabel(detail)} success={detail.publicStatus === "published"} />
            <MetricCell label="事件来源" value={`${eventDetail?.articleCount ?? detail.event?.articleCount ?? 1} 个`} />
            <MetricCell label="推送目标" value={latestPushLogs.length === 0 ? (eventDetail?.pushedAt ? "已推送" : "未推送") : `${successfulPushTargets}/${latestPushLogs.length} 成功`} warning={failedPushTargets > 0} success={successfulPushTargets > 0 && failedPushTargets === 0} last />
          </div>
        </header>

        <div className="grid items-start gap-2 lg:grid-cols-[minmax(380px,0.82fr)_minmax(520px,1.18fr)]">
          <main className="min-w-0 space-y-2">
            <section ref={contentPanelRef} className="scroll-mt-3 border bg-background">
              <SectionHeader title="AI 洞察" meta={detail.aiStatus === "done" ? "分析完成" : processingLabel(detail)} />
              <div className="p-3">
                <p className="break-words text-sm leading-7 text-pretty">{detail.summary || detail.excerpt || "暂无 AI 洞察"}</p>
                {keyPoints.length > 0 && <div className="mt-4 border-t pt-3"><p className="text-[11px] font-medium text-muted-foreground">核心要点</p><ol className="mt-2 space-y-2 text-sm leading-6">{keyPoints.map((point, index) => <li key={`${point}-${index}`} className="grid grid-cols-[22px_minmax(0,1fr)] gap-2"><span className="font-mono text-xs font-semibold tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span><span>{point}</span></li>)}</ol></div>}
                {(brands.length > 0 || detail.category || tags.length > 0) && <div className="mt-4 grid gap-x-4 gap-y-2 border-t pt-3 text-xs sm:grid-cols-2"><MetaRow label="品牌" value={brands.join("、") || "—"} /><MetaRow label="分类" value={detail.category || "—"} /><div className="sm:col-span-2"><MetaRow label="标签" value={tags.map((tag) => tag.name).join("、") || "—"} /></div></div>}
              </div>
              <div className="grid grid-cols-2 border-t text-[11px] sm:grid-cols-5">
                <ScoreEditor label="相关度" item={detail} field="relevance" value={detail.relevance} saving={rowSavingId === detail.id} onUpdate={queueRowUpdate} />
                <ScoreEditor label="事件分" item={detail} field="eventScore" value={detail.eventScore} saving={rowSavingId === detail.id} onUpdate={queueRowUpdate} />
                <ScoreEditor label="内容分" item={detail} field="contentScore" value={detail.contentScore} saving={rowSavingId === detail.id} onUpdate={queueRowUpdate} />
                <ScoreEditor label="广告概率" item={detail} field="adProbability" value={detail.adProbability} saving={rowSavingId === detail.id} onUpdate={queueRowUpdate} />
                <label className="border-b border-r p-2 text-center sm:border-b-0 sm:border-r-0"><span className="text-muted-foreground">内容判断</span><select aria-label="人工内容判断" disabled={rowSavingId === detail.id} value={detail.isAd ? "ad" : "normal"} onChange={(event) => queueRowUpdate(detail.id, { isAd: event.target.value === "ad" }, "人工内容判断已更新")} className="mt-1 h-7 w-full rounded-none border bg-background text-center text-xs"><option value="normal">正常</option><option value="ad">软文</option></select></label>
              </div>
            </section>

            {editing && <section className="grid gap-3 border bg-background p-4 sm:grid-cols-2"><label className="space-y-1 text-xs">品牌<Input className="rounded-none" value={draft.brand} onChange={(event) => setDraft((value) => ({ ...value, brand: event.target.value }))} /></label><label className="space-y-1 text-xs">分类<Input className="rounded-none" value={draft.category} onChange={(event) => setDraft((value) => ({ ...value, category: event.target.value }))} /></label><label className="space-y-1 text-xs sm:col-span-2">标签（逗号分隔）<Input className="rounded-none" value={draft.tags} onChange={(event) => setDraft((value) => ({ ...value, tags: event.target.value }))} /></label><label className="space-y-1 text-xs sm:col-span-2">AI 洞察<Textarea value={draft.summary} onChange={(event) => setDraft((value) => ({ ...value, summary: event.target.value }))} className="min-h-28 rounded-none" /></label><label className="space-y-1 text-xs sm:col-span-2">核心要点（每行一条）<Textarea value={draft.keyPoints} onChange={(event) => setDraft((value) => ({ ...value, keyPoints: event.target.value }))} className="min-h-28 rounded-none" /></label><Button size="sm" className="rounded-none sm:col-span-2" disabled={detailAction !== null} onClick={() => void saveEditorial()}>{detailAction === "edit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存人工修正</Button></section>}

            <section className="border bg-background">
              <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px]" onClick={() => { setShowFullContent((value) => !value); setRequestedPanel("content"); updateDetailUrl(detail.id, "content"); }}><span className="flex items-center gap-2"><FileText className="h-4 w-4" aria-hidden="true" />正文核验 <span className="font-normal text-muted-foreground">{cleanContentText.length.toLocaleString("zh-CN")} 字</span></span><ChevronDown className={`h-4 w-4 transition-transform ${showFullContent ? "rotate-180" : ""}`} aria-hidden="true" /></button>
              {showFullContent && <div className="max-h-[420px] overflow-y-auto border-t px-3 py-3 text-xs leading-6 break-words whitespace-pre-line text-pretty">{cleanContentText.slice(0, 12000) || "正文尚未准备好"}</div>}
            </section>

            {detail.pushLogs.length > 0 && <section className="border bg-background"><SectionHeader title="推送记录" meta={`${latestPushLogs.length} 个目标 · ${detail.pushLogs.length} 条记录`} /><div className="divide-y">{detail.pushLogs.map((log) => <div key={log.id} className="grid gap-1 px-4 py-2.5 text-xs sm:grid-cols-[110px_minmax(0,1fr)_72px_120px] sm:items-center sm:gap-3"><span className={`font-medium ${log.status === "success" ? "text-emerald-700" : log.status === "failed" || log.status === "failure" ? "text-red-700" : "text-amber-700"}`}>{pushStatusLabel(log.status)}{log.retryCount > 0 ? ` · 重试 ${log.retryCount}` : ""}</span><span className="min-w-0 truncate" title={log.webhookTarget}>{log.webhookRemark || log.webhookTarget || "未命名目标"}</span><span className="text-muted-foreground">{log.articleId === detail.id ? "本篇代表" : "历史代表"}</span><span className="font-mono text-[11px] tabular-nums text-muted-foreground sm:text-right">{fullTimeLabel(log.createdAt)}</span>{log.errorMessage && <p className="text-red-700 sm:col-span-4">{log.errorMessage}</p>}</div>)}</div></section>}
          </main>

          <aside className="min-w-0 space-y-2 lg:sticky lg:top-2">
            <section className="border bg-background">
              <SectionHeader title="公开与人工判断" meta={detail.reviewedAt ? `审核于 ${fullTimeLabel(detail.reviewedAt)}` : "尚未审核"} />
              <div className="space-y-2 p-3">
                <div className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-3 text-xs"><span className="text-muted-foreground">公开策略</span><select aria-label="人工公开策略" disabled={rowSavingId === detail.id} value={detail.publicOverride} onChange={(event) => queueRowUpdate(detail.id, { publicOverride: event.target.value as "auto" | "public" | "hidden" }, "公开策略已更新")} className="h-8 rounded-none border bg-background px-2 text-xs"><option value="auto">自动</option><option value="public">强制公开</option><option value="hidden">强制隐藏</option></select><span className="text-muted-foreground">实际结果</span><span className={`font-medium ${detail.publicStatus === "published" ? "text-emerald-700" : "text-amber-700"}`}>{publicResultLabel(detail)}</span><span className="text-muted-foreground">门禁说明</span><span className="leading-5">{detail.publicStatus === "published" ? "已通过当前公开规则" : publicReasonLabel(detail.publicPublicationReason)}</span></div>
                <div className="border-t pt-3"><p className="text-[11px] font-medium text-muted-foreground">归类原因</p><div className="mt-2 grid grid-cols-2 gap-2">{REASONS.map(([value, label]) => <label key={value} className="inline-flex cursor-pointer items-center gap-2 text-xs"><input type="checkbox" checked={reasonTags.includes(value)} onChange={(event) => setReasonTags((prev) => event.target.checked ? [...prev, value] : prev.filter((item) => item !== value))} />{label}</label>)}</div></div>
                <div className="grid grid-cols-3 gap-1.5"><Button size="sm" className="h-8 rounded-none bg-emerald-700 text-xs hover:bg-emerald-800" disabled={detailAction !== null} onClick={() => void handleDetailReview("important")}>{detailAction === "review" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}重要</Button><Button size="sm" variant="outline" className="h-8 rounded-none text-xs" disabled={detailAction !== null} onClick={() => void handleDetailReview("general")}>一般</Button><Button size="sm" variant="outline" className="h-8 rounded-none text-xs text-muted-foreground" disabled={detailAction !== null} onClick={() => void handleDetailReview("irrelevant")}>无关</Button></div>
                <p className="text-[10px] text-muted-foreground">快捷键：I 重要 · G 一般 · N 无关</p>
              </div>
            </section>

            {eventDetail && (
              <section ref={clusterPanelRef} className="scroll-mt-3 border bg-background">
                <SectionHeader title="Event 校准" meta={`${eventDetail.articleCount} 篇 · ${eventSourceCount} 个来源`} />
                <div className="space-y-3 p-3">
                  <div className="grid grid-cols-3 border text-center text-[10px] sm:grid-cols-6">
                    <EventMetric label="事件状态" value={detail.clusterStatus === "needs_review" ? "待复核" : "已归类"} warning={detail.clusterStatus === "needs_review"} />
                    <EventMetric label="代表方式" value={eventDetail.representativeManual ? "人工" : "自动"} />
                    <EventMetric label="评分范围" value={eventScoreRange} />
                    <EventMetric label="时间跨度" value={`${eventSpanDays} 天`} />
                    <EventMetric label="待处理" value={`${eventReviewCount} 篇`} warning={eventReviewCount > 0} />
                    <EventMetric label="可公开候选" value={`${eventPublicCandidateCount} 篇`} success={eventPublicCandidateCount > 0} />
                  </div>

                  <div className="grid gap-2 border bg-muted/20 p-2 text-xs">
                    <div className="flex items-start gap-2">
                      <span className="w-16 shrink-0 text-muted-foreground">当前代表</span>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 font-medium">{representativeMember?.title || "尚无可用代表文章"}</p>
                        {representativeMember && <p className="mt-0.5 text-[10px] text-muted-foreground">{representativeMember.source.name} · {representativeMember.score} 分 · 相关度 {representativeMember.relevance} · {reviewLabel(representativeMember.reviewStatus)}</p>}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-t pt-2 text-[11px]">
                      <MetaRow label="首次发现" value={fullTimeLabel(eventDetail.firstSeenAt)} />
                      <MetaRow label="最近发现" value={fullTimeLabel(eventDetail.lastSeenAt)} />
                      <MetaRow label="公开状态" value={eventDetail.publicStatus === "published" ? "已公开" : "未公开"} />
                      <MetaRow label="推送状态" value={eventDetail.pushedAt ? fullTimeLabel(eventDetail.pushedAt) : "未推送"} />
                      <div className="col-span-2"><MetaRow label="事件键" value={detail.eventKey || "未生成"} mono /></div>
                    </div>
                    {eventBlockedCount > 0 && <p className="border-t pt-2 text-[11px] text-amber-700">{eventBlockedCount} 篇成员暂不具备代表资格：可能未完成 AI/聚类，或来源已删除。</p>}
                  </div>

                  <div className="grid grid-cols-2 gap-1.5">
                    <Button size="sm" className="h-8 rounded-none text-xs" disabled={!canForcePush || eventAction !== null} onClick={() => void pushCurrentEvent(eventDetail.pushedAt ? "repush" : "manual")}><Send className="h-3.5 w-3.5" />{eventDetail.pushedAt ? "完整重推 Event" : "强制推送 Event"}</Button>
                    <Button size="sm" variant="outline" className="h-8 rounded-none text-xs" onClick={() => { const query = detail.title.slice(0, 30); setEventSearch(query); void searchEvents(query); }}><Search className="h-3.5 w-3.5" />查找相似 Event</Button>
                  </div>

                  {detail.clusterStatus === "needs_review" && <div className="grid gap-2 border border-amber-300 bg-amber-50 p-2"><p className="text-xs font-medium text-amber-950">当前聚类存在歧义。完成复核前，本篇不能成为代表、公开或推送。</p><div className="flex flex-wrap gap-1.5"><Button size="sm" className="h-7 rounded-none text-xs" disabled={eventAction !== null} onClick={() => void confirmIndependent()}>确认独立事件</Button>{recommendedEventId && <Button size="sm" variant="outline" className="h-7 rounded-none text-xs" disabled={eventAction !== null} onClick={() => void moveCurrentArticle(recommendedEventId)}>并入系统推荐 Event</Button>}</div></div>}

                  <div className="border-t pt-2">
                    <div className="mb-2 flex items-center gap-2">
                      <div><p className="text-xs font-semibold">事件成员对比</p><p className="text-[10px] text-muted-foreground">勾选成员可批量拆为同一个新 Event；至少保留一篇在当前 Event。</p></div>
                      {selectedSplitIds.size > 0 && <Button size="sm" variant="outline" className="ml-auto h-7 rounded-none px-2 text-[10px] text-amber-700" disabled={eventAction !== null} onClick={() => void splitArticles([...selectedSplitIds])}><Split className="h-3 w-3" />拆分所选 {selectedSplitIds.size} 篇</Button>}
                    </div>
                    <div className="max-h-80 overflow-y-auto border">
                      <div className="sticky top-0 z-[1] grid grid-cols-[24px_minmax(0,1fr)_38px_42px_42px] gap-1 border-b bg-background px-2 py-1 text-[9px] text-muted-foreground"><span /><span>文章 / 来源 / 状态</span><span className="text-center">总分</span><span className="text-center">相关</span><span className="text-center">置信</span></div>
                      {eventMembers.map((article) => {
                        const representative = eventDetail.representativeArticleId === article.id;
                        const selected = selectedSplitIds.has(article.id);
                        return <div key={article.id} className={`border-b p-2 last:border-b-0 ${article.id === detail.id ? "bg-sky-50" : selected ? "bg-amber-50" : ""}`}>
                          <div className="grid grid-cols-[24px_minmax(0,1fr)_38px_42px_42px] items-start gap-1 text-xs">
                            <input type="checkbox" aria-label={`选择拆分 ${article.title}`} checked={selected} disabled={eventDetail.articleCount <= 1 || eventAction !== null} onChange={() => toggleSplitSelection(article.id)} className="mt-1" />
                            <div className="min-w-0"><button type="button" onClick={() => selectArticle(article.id, "cluster")} className="line-clamp-2 text-left font-medium leading-4 hover:underline">{article.title}</button><div className="mt-1 flex flex-wrap gap-1 text-[9px]"><span className="text-muted-foreground">{article.source.name}</span>{representative && <span className="bg-foreground px-1 text-background">代表</span>}{article.clusterStatus === "needs_review" && <span className="bg-amber-500 px-1 text-white">待复核</span>}{article.reviewStatus === "unreviewed" && <span className="bg-red-500 px-1 text-white">待归类</span>}{article.isAd && <span className="bg-slate-500 px-1 text-white">软文</span>}{!article.source.publicEnabled && <span className="border px-1">来源不公开</span>}{article.source.deleted && <span className="bg-red-700 px-1 text-white">来源已删</span>}{article.publicStatus === "published" && <span className="bg-emerald-600 px-1 text-white">已公开</span>}</div></div>
                            <span className="text-center font-semibold tabular-nums">{article.score}</span><span className="text-center tabular-nums text-muted-foreground">{article.relevance}</span><span className="text-center tabular-nums text-muted-foreground">{article.aiConfidence == null ? "—" : article.aiConfidence}</span>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-6 text-[10px]"><span className="mr-auto text-muted-foreground">事件 {article.eventScore ?? "—"} · 内容 {article.contentScore ?? "—"} · {article.category || "未分类"}{article.brand ? ` · ${splitBrands(article.brand).join("、")}` : ""}</span>{!representative && <Button size="sm" variant="ghost" className="h-6 rounded-none px-1.5 text-[10px]" disabled={eventAction !== null || article.clusterStatus !== "clustered" || article.aiStatus !== "done" || article.source.deleted} onClick={() => void setRepresentative(article.id)}>设为代表</Button>}{eventDetail.articleCount > 1 && <Button size="sm" variant="ghost" className="h-6 rounded-none px-1.5 text-[10px] text-amber-700" disabled={eventAction !== null} onClick={() => void splitArticle(article.id)}>单独拆分</Button>}</div>
                        </div>;
                      })}
                    </div>
                  </div>

                  <details open={clusterAuditOpen || detail.clusterStatus === "needs_review"} onToggle={(event) => { const nextOpen = event.currentTarget.open; setClusterAuditOpen(nextOpen); if (nextOpen) { setRequestedPanel("cluster"); updateDetailUrl(detail.id, "cluster"); } }}><summary className="cursor-pointer border-t py-2 text-xs font-semibold">聚类依据与操作历史 · {currentEventAudits.length} 条</summary><div className="space-y-2">{currentEventAudits.slice(0, 8).map((audit) => <div key={audit.id} className="grid grid-cols-[58px_minmax(0,1fr)] border-l-2 border-muted-foreground/30 pl-2 text-[11px] leading-5"><span className="text-muted-foreground">{audit.actor === "admin" ? "人工操作" : "系统判断"}</span><div><p className="font-medium">{audit.action} · {audit.decisionSource}{audit.confidence == null ? "" : ` · 置信度 ${audit.confidence}%`}</p><p className="text-muted-foreground">{String((audit.evidence.aiDecision as { reason?: unknown } | undefined)?.reason ?? audit.evidence.reason ?? audit.evidence.aiReason ?? "无补充理由")}</p>{audit.candidateEvent?.representativeArticle?.title && <p className="text-muted-foreground">关联候选：{audit.candidateEvent.representativeArticle.title}</p>}<p className="text-[9px] text-muted-foreground">{fullTimeLabel(audit.createdAt)}</p></div></div>)}{currentEventAudits.length === 0 && <p className="text-[11px] text-muted-foreground">暂无聚类审计记录</p>}</div></details>

                  <details open={detail.clusterStatus === "needs_review" || eventOptions.length > 0}><summary className="cursor-pointer border-t py-2 text-xs font-semibold">移动文章或合并 Event</summary><div className="space-y-2"><div className="flex gap-1.5"><Input value={eventSearch} onChange={(event) => setEventSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchEvents(); }} placeholder="输入标题、品牌、事件键；留空显示最近 Event" className="h-8 rounded-none text-xs" /><Button size="sm" variant="outline" className="h-8 shrink-0 rounded-none px-2 text-xs" onClick={() => void searchEvents()}><Search className="h-3.5 w-3.5" />搜索</Button></div>{eventOptions.length > 0 ? <div className="max-h-64 divide-y overflow-y-auto border">{eventOptions.map((event) => <div key={event.id} className={`p-2 text-xs ${mergeTargetId === event.id ? "bg-sky-50" : ""}`}><p className="line-clamp-2 font-medium">{event.representativeArticle?.title || `Event ${event.id.slice(-8)}`}</p><div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground"><span>{event.articleCount} 篇</span><span>{event.representativeArticle?.source.name || "未知来源"}</span><span>{event.representativeArticle ? `${event.representativeArticle.score} 分 / 相关 ${event.representativeArticle.relevance}` : "无代表"}</span><span>{event.publicStatus === "published" ? "已公开" : "未公开"}</span><span>{event.pushedAt ? "已推送" : "未推送"}</span><span>{fullTimeLabel(event.lastSeenAt)}</span></div><div className="mt-1.5 flex gap-1"><Button size="sm" variant="outline" className="h-6 rounded-none px-1.5 text-[10px]" disabled={eventAction !== null} onClick={() => void moveCurrentArticle(event.id)}>仅移动当前文章</Button><Button size="sm" variant="ghost" className="h-6 rounded-none px-1.5 text-[10px]" onClick={() => setMergeTargetId(event.id)}>选择为整组目标</Button></div></div>)}</div> : <p className="text-[10px] text-muted-foreground">搜索后可比较目标 Event，再决定仅移动当前文章，或把当前整个 Event 合并过去。</p>}<div className="flex gap-1.5"><Input value={mergeTargetId} readOnly placeholder="尚未选择整组合并目标" className="h-8 rounded-none text-xs" /><Button size="sm" variant="outline" className="h-8 shrink-0 rounded-none px-2 text-xs text-amber-700" disabled={!mergeTargetId || eventAction !== null} onClick={() => void mergeCurrentEvent()}><Merge className="h-3.5 w-3.5" />整组并入</Button></div></div></details>
                </div>
              </section>
            )}

            <section className="border bg-background"><SectionHeader title="文章全貌" meta={`Article ${detail.id.slice(-8)}`} /><div className="grid grid-cols-2 divide-x border-b"><div className="p-3"><Eye className="h-4 w-4 text-muted-foreground" aria-hidden="true" /><p className="mt-2 font-mono text-lg font-semibold tabular-nums">{detail.viewCount.toLocaleString("zh-CN")}</p><p className="text-[10px] text-muted-foreground">公开浏览</p></div><div className="p-3"><MousePointerClick className="h-4 w-4 text-muted-foreground" aria-hidden="true" /><p className="mt-2 font-mono text-lg font-semibold tabular-nums">{detail.originalClickCount.toLocaleString("zh-CN")}</p><p className="text-[10px] text-muted-foreground">原文点击 · {clickRate}%</p></div></div><div className="space-y-2 p-3 text-xs"><MetaRow label="详情处理" value={stageStatusLabel("fetch", detail.fetchStatus)} /><MetaRow label="事件聚类" value={stageStatusLabel("cluster", detail.clusterStatus)} /><MetaRow label="AI 分析" value={stageStatusLabel("ai", detail.aiStatus)} />{detail.skipReason && <MetaRow label="跳过原因" value={detail.skipReason} />}<MetaRow label="创建时间" value={fullTimeLabel(detail.createdAt)} /><MetaRow label="更新时间" value={fullTimeLabel(detail.updatedAt)} /><MetaRow label="发布时间" value={fullTimeLabel(detail.publishedAt)} /><MetaRow label="聚类时间" value={fullTimeLabel(detail.clusteredAt)} /><MetaRow label="人工修正" value={detail.manualCorrectedAt ? fullTimeLabel(detail.manualCorrectedAt) : "无"} />{detail.pinUntil && <MetaRow label="置顶截止" value={fullTimeLabel(detail.pinUntil)} />}<MetaRow label="原始评分" value={detail.rawScore == null ? "—" : String(detail.rawScore)} mono /><MetaRow label="文章 ID" value={detail.id} mono /><MetaRow label="来源类型" value={detail.source.type} /><div className="grid min-w-0 grid-cols-[74px_minmax(0,1fr)] gap-2"><span className="text-muted-foreground">来源主页</span><a className="min-w-0 truncate underline-offset-2 hover:underline" href={detail.source.url} target="_blank" rel="noreferrer" title={detail.source.url}>{detail.source.url}</a></div></div>{manualOverrides.length > 0 && <div className="border-t p-3"><p className="text-[11px] font-medium text-muted-foreground">人工覆盖字段</p><div className="mt-2 flex flex-wrap gap-1.5">{manualOverrides.map((field) => <Badge key={field} variant="secondary" className="rounded-none px-1.5 text-[10px]">{manualFieldLabel(field)}</Badge>)}</div></div>}</section>
          </aside>
        </div>
      </div>
    </ScrollArea>
  ) : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">文章不存在或尚未选择</div>;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 [&>[data-slot=sheet-close]]:z-10 [&>[data-slot=sheet-close]]:rounded-none [&>[data-slot=sheet-close]]:bg-background sm:max-w-[min(1240px,96dvw)]">
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
    <div className="flex min-h-10 items-center gap-3 border-b px-3 py-2">
      <h2 className="text-xs font-semibold">{title}</h2>
      {meta && <span className="ml-auto text-[10px] text-muted-foreground">{meta}</span>}
    </div>
  );
}

function EventMetric({
  label,
  value,
  warning = false,
  success = false,
}: {
  label: string;
  value: string;
  warning?: boolean;
  success?: boolean;
}) {
  return (
    <div className="border-b border-r p-1.5 last:border-r-0 sm:border-b-0">
      <p className="text-muted-foreground">{label}</p>
      <p className={`mt-0.5 truncate text-xs font-semibold tabular-nums ${warning ? "text-amber-700" : success ? "text-emerald-700" : ""}`} title={value}>{value}</p>
    </div>
  );
}

function MetricCell({
  label,
  value,
  strong = false,
  warning = false,
  success = false,
  last = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  warning?: boolean;
  success?: boolean;
  last?: boolean;
}) {
  return (
    <div className={`min-w-0 border-b border-r p-2.5 lg:border-b-0 ${last ? "lg:border-r-0" : ""}`}>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`mt-1 truncate tabular-nums ${strong ? "text-xl font-semibold" : "font-medium"} ${warning ? "text-amber-700" : success ? "text-emerald-700" : ""}`} title={value}>{value}</p>
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
      <span className={`min-w-0 break-words ${mono ? "font-mono text-[11px] tabular-nums" : ""}`} title={value}>{value}</span>
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
    <div className="border-b border-r p-2 text-center sm:border-b-0">
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
