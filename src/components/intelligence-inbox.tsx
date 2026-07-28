"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Eye,
  FileText,
  Loader2,
  Merge,
  MousePointerClick,
  Save,
  Search,
  Split,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  triggerArticleWorkflow,
  updateArticleEditorial,
} from "@/features/articles-api.client";
import {
  parseManualOverrides,
} from "@/lib/shared/article-calibration";
import { isBusinessSkipReason } from "@/lib/article-pipeline-status";
import { isRequestAborted, isRequestJsonError } from "@/lib/request-json.client";
import {
  parseJsonArray,
  splitBrands,
  stripHtml,
} from "@/lib/shared/article-codecs";
import { parseEventSubjects } from "@/contracts/event-identity";
import { EventArticleList, type EventArticleRowModel } from "@/components/article-workspace/event-article-list";

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

const WORKSPACE_ACTION_CLASS = "min-h-7 h-auto max-w-full rounded-none px-2 text-left text-xs font-medium leading-4 whitespace-normal sm:whitespace-nowrap";

const FULL_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

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
  if (item.aiStatus === "skipped" && isBusinessSkipReason(item.skipReason))
    return item.skipReason === "无具体事件" ? "分析完成（无具体事件）" : "分析完成（多事件稿）";
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

function recommendationSignals(audit: {
  evidence: Record<string, unknown>;
} | null, candidateEventId?: string | null): string[] {
  if (!audit) return [];
  const candidates = audit.evidence.candidates;
  if (!Array.isArray(candidates)) return [];
  const candidate = (candidates.find((item) => {
    if (!item || typeof item !== "object" || !candidateEventId) return false;
    return (item as { candidateEventId?: unknown }).candidateEventId === candidateEventId;
  }) as Record<string, unknown> | undefined)
    ?? (candidates.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined);
  const ruleEvidence = candidate?.ruleEvidence;
  if (!ruleEvidence || typeof ruleEvidence !== "object" || Array.isArray(ruleEvidence)) return [];
  const evidence = ruleEvidence as Record<string, unknown>;
  const signals: string[] = [];
  if (evidence.eventKeyMatch === true) signals.push("事件键一致");
  if (evidence.fingerprintMatch === true) signals.push("正文指纹一致");
  if (typeof evidence.identityScore === "number") signals.push(`身份相似度 ${Math.round(evidence.identityScore * 100)}%`);
  if (typeof evidence.titleOverlap === "number") signals.push(`标题相似度 ${Math.round(evidence.titleOverlap * 100)}%`);
  if (typeof evidence.daysApart === "number") signals.push(`相隔 ${Math.round(evidence.daysApart)} 天`);
  return signals.slice(0, 4);
}

function stageStatusLabel(stage: "fetch" | "cluster" | "ai", status: string, skipReason?: string | null): string {
  if (stage === "ai" && status === "skipped" && isBusinessSkipReason(skipReason)) {
    return skipReason === "无具体事件" ? "已完成（无具体事件）" : "已完成（多事件稿）";
  }
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
    "edit" | "workflow" | null
  >(null);
  const [editing, setEditing] = useState(false);
  const [showFullContent, setShowFullContent] = useState(false);
  const [showSystemInfo, setShowSystemInfo] = useState(false);
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
  const detailScrollContainerRef = useRef<HTMLDivElement>(null);
  const rowWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const rowSavingRef = useRef<string | null>(null);
  const eventDetailRequestRef = useRef(0);
  const eventSearchRequestRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);

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
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = detailScrollContainerRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      );
      if (!viewport) return;
      viewport.scrollTop = 0;
      viewport.scrollLeft = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detail?.id, open, selectedId]);

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
        setEditing(false);
        setShowFullContent(false);
        setShowSystemInfo(false);
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
    if (requestedPanel === "content") {
      setShowSystemInfo(true);
      setShowFullContent(true);
    }
    // 面板入口只控制展开状态，不改变抽屉当前滚动位置；所有文章详情统一从顶部开始。
  }, [detail, requestedPanel, selectedId]);

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
    [detail],
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

  const moveCurrentArticleToEvent = async (
    targetEventId: string,
    targetLabel: string,
    actionKey = "move",
  ) => {
    if (!detail?.eventId || eventAction || !targetEventId) return;
    if (!window.confirm(`将当前文章并入目标 Event：\n${detail.title}\n\n目标 Event 参考文章：${targetLabel}\n\n仅移动当前文章，目标 Event 的其他文章不变；两边的代表文章和公开状态会自动重新计算。确认继续吗？`)) return;
    setEventAction(actionKey);
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
      toast.success("当前文章已并入目标 Event");
    } catch (error) {
      toast.error(errorMessage(error, "移动文章失败"));
    } finally {
      setEventAction(null);
    }
  };

  const moveCurrentArticle = async (targetEventId: string) => {
    const target = eventOptions.find((event) => event.id === targetEventId);
    await moveCurrentArticleToEvent(
      targetEventId,
      target?.representativeArticle?.title || targetEventId,
    );
  };

  const moveBrandCandidate = async (candidate: EventDetail["brandCandidates"][number]) => {
    if (!detail?.eventId || !eventDetail || eventAction) return;
    if (!window.confirm(`将候选文章移入当前 Event：\n${candidate.title}\n\n仅移动这一篇候选文章，当前 Event 将新增 1 篇成员；两边的代表文章和公开状态会自动重新计算。确认继续吗？`)) return;
    setEventAction(`move-candidate:${candidate.id}`);
    try {
      const response = await fetch(
        `/api/events/${encodeURIComponent(candidate.eventId)}/move`,
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

  const moveCurrentArticleToBrandEvent = async (candidate: EventDetail["brandCandidates"][number]) => {
    if (!detail?.eventId || !eventDetail || eventAction) return;
    await moveCurrentArticleToEvent(
      candidate.eventId,
      candidate.title,
      `move-current-brand:${candidate.id}`,
    );
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

  const recommendedAudit = eventDetail?.audits.find(
    (audit) =>
      audit.articleId === detail?.id &&
      audit.actor === "system" &&
      audit.candidateEvent?.status === "active",
  ) ?? null;
  const recommendedEventId = recommendedAudit?.candidateEventId ?? null;
  const recommendedEvent = recommendedAudit?.candidateEvent ?? null;

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
      const leftTime = new Date(left.publishedAt || left.createdAt).getTime();
      const rightTime = new Date(right.publishedAt || right.createdAt).getTime();
      return rightTime - leftTime;
    });
  }, [eventDetail]);
  const brandCandidates = eventDetail?.brandCandidates ?? [];
  const eventMemberModels: EventArticleRowModel[] = eventMembers.map((article, index) => {
    const representative = eventDetail?.representativeArticleId === article.id;
    const selected = selectedSplitIds.has(article.id);
    return {
      id: article.id,
      index: index + 1,
      time: timeLabel(article.publishedAt || article.createdAt),
      score: article.score,
      source: article.source.name,
      title: article.title,
      representative: representative ? <StatusBadge tone="representative">代表文章</StatusBadge> : <span className="text-muted-foreground">—</span>,
      brand: article.brand ? splitBrands(article.brand).join(" / ") : "—",
      selection: <input type="checkbox" aria-label={`选择拆分 ${article.title}`} checked={selected} disabled={(eventDetail?.articleCount ?? 0) <= 1 || eventAction !== null} onChange={() => toggleSplitSelection(article.id)} />,
      actions: <>
        {!representative && <Button size="sm" variant="ghost" className="h-7 rounded-none px-2 text-xs" disabled={eventAction !== null || article.clusterStatus !== "clustered" || article.aiStatus !== "done" || article.source.deleted} onClick={() => void setRepresentative(article.id)}>设为代表文章</Button>}
        {!representative && (eventDetail?.articleCount ?? 0) > 1 && <Button size="sm" variant="ghost" className="h-7 rounded-none px-2 text-xs text-amber-700" disabled={eventAction !== null} onClick={() => void splitArticle(article.id)}>拆为独立事件</Button>}
      </>,
      tone: "member",
      highlight: article.id === detail?.id ? "current" : selected ? "selected" : representative ? "representative" : undefined,
      onTitleClick: () => selectArticle(article.id, "cluster"),
    };
  });
  const recommendedModel: EventArticleRowModel | null = recommendedEventId && recommendedEvent?.representativeArticle
    ? (() => {
        const article = recommendedEvent.representativeArticle;
        const signals = recommendationSignals(recommendedAudit, recommendedEventId);
        return {
          id: `recommended:${recommendedEventId}`,
          index: "推荐",
          time: timeLabel(article.publishedAt || article.createdAt),
          score: article.score,
          source: article.source.name,
          title: article.title,
          representative: <StatusBadge tone="recommended">其他事件代表文章</StatusBadge>,
          brand: article.brand ? splitBrands(article.brand).join(" / ") : "—",
          reason: signals.length > 0 ? signals.join(" · ") : "系统检测到身份、标题或正文存在相似信号",
          actions: <Button size="sm" variant="outline" className="h-7 rounded-none border-sky-400 px-2 text-xs text-sky-800 hover:bg-sky-100" disabled={eventAction !== null} onClick={() => void moveCurrentArticle(recommendedEventId)}>将当前文章移至该事件</Button>,
          tone: "recommended",
        };
      })()
    : null;
  const brandCandidateModels: EventArticleRowModel[] = brandCandidates.map((candidate, index) => {
    const articleBrands = candidate.brand ? splitBrands(candidate.brand).join(" / ") : "—";
    const matchedBrands = candidate.matchedBrands.join(" / ") || "—";
    const brandLabel = matchedBrands === "—" || matchedBrands === articleBrands
      ? articleBrands
      : `${articleBrands} · 匹配 ${matchedBrands}`;
    return {
      id: `brand:${candidate.id}`,
      index: index + 1,
      time: timeLabel(candidate.publishedAt || candidate.createdAt),
      score: candidate.score,
      source: candidate.source.name,
      title: candidate.title,
      titleClassName: "text-amber-950",
      representative: candidate.isEventRepresentative ? <StatusBadge tone="recommended">其他事件代表文章</StatusBadge> : <span className="text-muted-foreground">—</span>,
      brand: brandLabel,
      reason: `品牌相同：${matchedBrands} · 近 30 天内 · 当前属于其他事件`,
      actions: <>
        <Button size="sm" variant="outline" className="h-7 rounded-none border-amber-400 px-2 text-xs text-amber-800 hover:bg-amber-100" title="只把这篇文章并入当前事件" disabled={eventAction !== null} onClick={() => void moveBrandCandidate(candidate)}>并入当前事件</Button>
        <Button size="sm" variant="ghost" className="h-7 rounded-none px-2 text-xs text-sky-800 hover:bg-sky-100" title="只把当前文章移到这篇文章所属事件" disabled={eventAction !== null} onClick={() => void moveCurrentArticleToBrandEvent(candidate)}>将当前移至该事件</Button>
      </>,
      tone: "brand",
      onTitleClick: () => selectArticle(candidate.id, "cluster"),
    };
  });
  const eventSourceCount = new Set(eventMembers.map((article) => article.source.name)).size;
  const clickRate = detail && detail.viewCount > 0
    ? Math.round((detail.originalClickCount / detail.viewCount) * 100)
    : 0;
  const latestPushAt = detail?.pushLogs.reduce<string | null>((latest, log) => {
    if (!latest || new Date(log.createdAt).getTime() > new Date(latest).getTime()) return log.createdAt;
    return latest;
  }, null) ?? null;
  const displaySource = detail?.originalSource?.trim() || detail?.source.name || "—";
  const eventIdentity = detail
    ? [parseEventSubjects(detail.eventSubjects).join("、"), detail.eventAction, detail.eventObject].filter(Boolean).join(" / ") || detail.eventKey || "未形成事件身份"
    : "未形成事件身份";
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
  const detailWorkspace = detailLoading ? (
    <div className="space-y-2 p-3 lg:p-4">
      <Skeleton className="h-28 w-full rounded-none" />
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1.18fr)_minmax(360px,0.82fr)]">
        <Skeleton className="h-[520px] w-full rounded-none" />
        <Skeleton className="h-[520px] w-full rounded-none" />
      </div>
    </div>
  ) : detail ? (
    <ScrollArea className="h-full w-full min-w-0 overscroll-contain">
      <div className="mx-auto w-full min-w-0 max-w-[960px] space-y-1 p-1 sm:p-1.5">
        <header className="sticky top-0 z-20 min-w-0 overflow-hidden border-b bg-background/95 shadow-sm backdrop-blur">
          <div className="min-w-0 p-2.5 pr-12 sm:pr-10">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="break-words text-base font-semibold leading-5 text-balance sm:text-lg sm:leading-6">{detail.title}</h1>
                <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1 text-xs">
                  <StatusBadge tone={detail.publicStatus === "published" ? "success" : detail.clusterStatus === "needs_review" ? "warning" : "neutral"}>{processingLabel(detail)}</StatusBadge>
                  {detail.publicStatus === "published" && <StatusBadge tone="success">已公开</StatusBadge>}
                  {isRepresentative && <StatusBadge tone="representative">代表文章</StatusBadge>}
                  <span className="ml-1 font-mono font-semibold tabular-nums">综合分 {detail.score}</span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground" title={`${displaySource} · ${fullTimeLabel(detail.publishedAt ?? detail.createdAt)}`}>
                  {displaySource} · {fullTimeLabel(detail.publishedAt ?? detail.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 items-start gap-1">
                <a className={`inline-flex items-center border bg-background hover:bg-muted ${WORKSPACE_ACTION_CLASS}`} href={detail.url} target="_blank" rel="noreferrer">查看原文</a>
                <Button size="sm" variant="outline" className={WORKSPACE_ACTION_CLASS} disabled={detailAction !== null} onClick={() => setEditing((value) => !value)}>{editing ? "取消编辑" : "编辑文章"}</Button>
                <details className="relative">
                  <summary className={`flex cursor-pointer list-none items-center border bg-background hover:bg-muted ${WORKSPACE_ACTION_CLASS}`}>
                    更多操作 <ChevronDown className="h-3 w-3" aria-hidden="true" />
                  </summary>
                  <div className="absolute right-0 top-full z-30 mt-1 grid min-w-48 gap-1 border bg-background p-1 shadow-md">
                    <Button size="sm" variant="ghost" className="h-7 justify-start rounded-none px-2 text-xs" disabled={detailAction !== null} onClick={() => void startWorkflow("process")}>重新抓取并全量重跑</Button>
                  </div>
                </details>
              </div>
            </div>
            <details className="mt-2 border-t pt-1.5">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground">更多信息 <ChevronDown className="h-3 w-3" aria-hidden="true" /></summary>
              <div className="mt-1.5 grid min-w-0 grid-cols-2 gap-px border bg-border text-xs sm:grid-cols-3 lg:grid-cols-4">
                <DetailMetaItem label="分类" value={detail.category || "—"} />
                <DetailMetaItem label="品牌" value={brands.join("、") || "—"} />
                <DetailMetaItem label="事件键" value={`${detail.eventKey || "—"}${detail.eventKeyConfidence == null ? "" : `（${detail.eventKeyConfidence}%）`}`} mono />
                <DetailMetaItem label="相关度" value={String(detail.relevance)} mono />
                <DetailMetaItem label="事件分" value={detail.eventScore == null ? "—" : String(detail.eventScore)} mono />
                <DetailMetaItem label="内容分" value={detail.contentScore == null ? "—" : String(detail.contentScore)} mono />
                <DetailMetaItem label="分析置信" value={detail.aiConfidence == null ? "—" : `${detail.aiConfidence}%`} mono />
                <DetailMetaItem label="广告概率" value={detail.adProbability == null ? "—" : `${detail.adProbability}%`} mono />
                <DetailMetaItem label="内容判断" value={detail.isAd ? "软文" : "正常"} />
                <DetailMetaItem label="状态" value={`${clusterLabel(detail)}${manualOverrides.length > 0 ? ` · 人工修正${manualOverrides.length}项` : ""}`} />
                <DetailMetaItem label="来源类型" value={detail.source.type} />
                <DetailMetaItem label="发布时间" value={fullTimeLabel(detail.publishedAt)} mono />
              </div>
            </details>
          </div>
        </header>

        <div className="min-w-0 space-y-1">
          <main className="min-w-0 space-y-1">
            <section className="min-w-0 border bg-background">
              <div className="flex min-w-0 items-center justify-between gap-2 border-b px-2.5 py-1.5">
                <h2 className="text-sm font-semibold">文章内容与 AI 分析</h2>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{detail.aiStatus === "done" ? "分析完成" : processingLabel(detail)}</span>
                  <Button size="sm" variant="ghost" className="h-6 rounded-none px-1.5 text-xs" disabled={detailAction !== null} onClick={() => void startWorkflow("ai")}>重新生成</Button>
                </div>
              </div>
              <div className="min-w-0 grid gap-3 p-2.5 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
                <div className="min-w-0 overflow-hidden">
                  <h3 className="mb-1.5 text-xs font-semibold">核心事实</h3>
                  {keyPoints.length > 0 ? <ol className="space-y-1.5 text-sm leading-6">{keyPoints.map((point, index) => <li key={`${point}-${index}`} className="grid min-w-0 grid-cols-[24px_minmax(0,1fr)] gap-1.5"><span className="font-mono text-xs font-semibold tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span><span className="min-w-0 break-words">{point}</span></li>)}</ol> : <p className="break-words text-sm leading-6 text-muted-foreground">暂无核心事实</p>}
                </div>
                <div className="min-w-0 overflow-hidden border-t pt-2.5 lg:border-l lg:border-t-0 lg:pl-3">
                  <h3 className="text-xs font-semibold">AI 判断</h3>
                  <p className="mt-1.5 max-w-full whitespace-normal break-words text-sm leading-6">{detail.summary || detail.excerpt || "暂无 AI 判断"}</p>
                </div>
              </div>
            </section>

            {editing && <section className="grid gap-2 border bg-background p-3 sm:grid-cols-2"><label className="space-y-1 text-xs">品牌<Input className="h-8 rounded-none text-xs" value={draft.brand} onChange={(event) => setDraft((value) => ({ ...value, brand: event.target.value }))} /></label><label className="space-y-1 text-xs">分类<Input className="h-8 rounded-none text-xs" value={draft.category} onChange={(event) => setDraft((value) => ({ ...value, category: event.target.value }))} /></label><label className="space-y-1 text-xs">事件主体（多个主体用逗号分隔）<Input className="h-8 rounded-none text-xs" value={draft.eventSubjects} onChange={(event) => setDraft((value) => ({ ...value, eventSubjects: event.target.value }))} /></label><label className="space-y-1 text-xs">事件行为（保留计划/正式/完成等阶段）<Input className="h-8 rounded-none text-xs" value={draft.eventAction} onChange={(event) => setDraft((value) => ({ ...value, eventAction: event.target.value }))} /></label><label className="space-y-1 text-xs sm:col-span-2">具体事项<Input className="h-8 rounded-none text-xs" value={draft.eventObject} onChange={(event) => setDraft((value) => ({ ...value, eventObject: event.target.value }))} /></label><label className="space-y-1 text-xs sm:col-span-2">AI 洞察<Textarea value={draft.summary} onChange={(event) => setDraft((value) => ({ ...value, summary: event.target.value }))} className="min-h-24 rounded-none text-xs" /></label><label className="space-y-1 text-xs sm:col-span-2">核心要点（每行一条）<Textarea value={draft.keyPoints} onChange={(event) => setDraft((value) => ({ ...value, keyPoints: event.target.value }))} className="min-h-24 rounded-none text-xs" /></label><Button size="sm" className="h-8 rounded-none text-xs sm:col-span-2" disabled={detailAction !== null} onClick={() => void saveEditorial()}>{detailAction === "edit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存人工修正</Button></section>}

          </main>

          <aside className="min-w-0 space-y-1">
            <section className="border bg-background">
              <SectionHeader title="审核与发布" />
              <div className="space-y-2 p-2.5">
                <div className="grid grid-cols-2 gap-px border bg-border text-center text-xs sm:grid-cols-4">
                  <ScoreMetric label="内容分" value={detail.contentScore ?? "—"} />
                  <ScoreMetric label="事件分" value={detail.eventScore ?? "—"} />
                  <ScoreMetric label="分析置信" value={detail.aiConfidence == null ? "—" : `${detail.aiConfidence}%`} />
                  <ScoreMetric label="广告概率" value={detail.adProbability == null ? "—" : `${detail.adProbability}%`} />
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="font-medium">当前：</span>
                  <StatusBadge tone={detail.publicStatus === "published" ? "success" : "warning"}>{publicResultLabel(detail)}</StatusBadge>
                  <span className="text-muted-foreground">· {detail.publicStatus === "published" ? "符合当前公开规则" : publicReasonLabel(detail.publicPublicationReason)}</span>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <label className="flex items-center gap-1.5">公开策略
                    <select aria-label="人工公开策略" disabled={rowSavingId === detail.id} value={detail.publicOverride} onChange={(event) => queueRowUpdate(detail.id, { publicOverride: event.target.value as "auto" | "public" | "hidden" }, "公开策略已更新")} className="h-7 rounded-none border bg-background px-1.5 text-xs text-foreground"><option value="auto">自动</option><option value="public">强制公开</option><option value="hidden">隐藏文章</option></select>
                  </label>
                  <span>最近推送：{latestPushAt ? fullTimeLabel(latestPushAt) : "未推送"}</span>
                </div>
                <div className="flex flex-wrap gap-1 border-t pt-2">
                  {canForcePush && <Button size="sm" variant="outline" className="h-7 rounded-none border-amber-400 px-2 text-xs text-amber-800 hover:bg-amber-50" disabled={eventAction !== null} onClick={() => void pushCurrentEvent(eventDetail?.pushedAt ? "repush" : "manual")}>{eventDetail?.pushedAt ? "再次推送" : "强制推送"}</Button>}
                  {!isRepresentative && <span className="self-center text-xs text-muted-foreground">当前文章不是代表文章，不能单独公开或推送。</span>}
                </div>
              </div>
            </section>

            {eventDetail && (
              <section className="min-w-0 bg-background">
                <SectionHeader title="事件校准" meta={`${eventDetail.articleCount} 篇 · ${eventSourceCount} 个来源`} />
                <div className="space-y-2 p-2.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="font-medium">当前事件：</span><span className="break-words text-muted-foreground">{eventIdentity}</span>
                    <span className="text-muted-foreground">· {eventDetail.representativeManual ? "人工指定代表" : "系统选择代表"}</span>
                  </div>
                  {detail.clusterStatus === "needs_review" && <div className="grid gap-1.5 border border-amber-300 bg-amber-50 p-2"><p className="text-xs font-medium text-amber-950">当前聚类存在歧义。完成复核前，本篇不能成为代表、公开或推送。</p><div className="flex flex-wrap gap-1"><Button size="sm" className="h-7 rounded-none px-1.5 text-xs" disabled={eventAction !== null} onClick={() => void confirmIndependent()}>确认独立事件</Button></div></div>}

                  <Tabs defaultValue="members" className="min-w-0 gap-2">
                    <TabsList className="grid h-auto w-full grid-cols-2 rounded-none border bg-muted/40 p-0 sm:grid-cols-4">
                      <TabsTrigger value="members" className="h-8 rounded-none px-2 text-xs">当前成员 {eventDetail.articleCount}</TabsTrigger>
                      <TabsTrigger value="recommended" className="h-8 rounded-none px-2 text-xs">候选关联 {recommendedModel ? 1 : 0}</TabsTrigger>
                      <TabsTrigger value="brand" className="h-8 rounded-none px-2 text-xs">同品牌 {brandCandidates.length}</TabsTrigger>
                      <TabsTrigger value="operations" className="h-8 rounded-none px-2 text-xs">操作记录 {currentEventAudits.length}</TabsTrigger>
                    </TabsList>

                    <TabsContent value="members" className="min-w-0 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <p className="text-xs text-muted-foreground">当前事件中的文章。可勾选后拆为独立事件，至少保留一篇。</p>
                        {selectedSplitIds.size > 0 && <Button size="sm" variant="outline" className="ml-auto h-7 rounded-none px-1.5 text-xs text-amber-700" disabled={eventAction !== null} onClick={() => void splitArticles([...selectedSplitIds])}><Split className="h-3 w-3" />拆分所选 {selectedSplitIds.size} 篇</Button>}
                      </div>
                      <EventArticleList rows={eventMemberModels} />
                    </TabsContent>

                    <TabsContent value="recommended" className="min-w-0 space-y-1.5">
                      <p className="text-xs text-muted-foreground">系统认为可能相关的其他事件。操作只移动当前文章，不会影响目标事件的其他成员。</p>
                      {recommendedModel ? <EventArticleList rows={[recommendedModel]} /> : <p className="border border-dashed px-2.5 py-3 text-xs text-muted-foreground">暂无系统推荐候选。</p>}
                    </TabsContent>

                    <TabsContent value="brand" className="min-w-0 space-y-1.5">
                      <p className="text-xs text-muted-foreground">近 30 天内与当前文章有品牌交集、但属于其他事件的文章。可单篇并入当前事件，或将当前文章移至候选所属事件。</p>
                      <EventArticleList rows={brandCandidateModels} />
                    </TabsContent>

                    <TabsContent value="operations" className="min-w-0 space-y-2">
                      <div className="max-h-[260px] overflow-y-auto border-y"><div className="divide-y">{currentEventAudits.slice(0, 8).map((audit) => { const reason = clusterAuditReason(audit); return <div key={audit.id} className={`flex gap-2 border-l-2 px-2.5 py-2 text-xs leading-4 ${audit.actor === "admin" ? "border-sky-400" : "border-muted-foreground/30"}`}><div className="min-w-0 flex-1"><p className="flex flex-wrap items-center gap-x-2 gap-y-0.5"><span className="font-medium">{clusterAuditActionLabel(audit.action)}</span><span className="text-muted-foreground">{audit.actor === "admin" ? "人工" : "系统"}</span>{audit.confidence != null && <span className="text-muted-foreground">聚类置信度 {audit.confidence}%</span>}<time className="text-muted-foreground">{fullTimeLabel(audit.createdAt)}</time></p>{reason && <p className="mt-0.5 break-words text-muted-foreground">{reason}</p>}{audit.candidateEvent?.representativeArticle?.title && <p className="mt-0.5 break-words text-muted-foreground" title={audit.candidateEvent.representativeArticle.title}>关联：{audit.candidateEvent.representativeArticle.title}</p>}</div></div>; })}{currentEventAudits.length === 0 && <p className="px-2.5 py-2 text-xs text-muted-foreground">暂无聚类记录</p>}</div></div>
                      <div className="space-y-2 border-t pt-2"><div><p className="text-xs font-semibold">更改所属事件</p><p className="text-xs text-muted-foreground">移动当前文章只影响本篇；整组并入会移动当前 Event 的全部文章。</p></div><div className="flex min-w-0 gap-1"><Input value={eventSearch} onChange={(event) => setEventSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchEvents(); }} placeholder="搜索标题、品牌或事件键" className="h-7 min-w-0 rounded-none text-xs" /><Button size="sm" variant="outline" className="h-7 shrink-0 rounded-none px-1.5 text-xs" onClick={() => void searchEvents()}><Search className="h-3 w-3" />搜索</Button></div><button type="button" className="text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => { const query = detail.title.slice(0, 30); setEventSearch(query); void searchEvents(query); }}>用当前标题搜索相似事件</button>{eventOptions.length > 0 ? <div className="max-h-56 divide-y overflow-y-auto border">{eventOptions.map((event) => <div key={event.id} className={`p-2 text-xs ${mergeTargetId === event.id ? "bg-sky-50" : ""}`}><p className="line-clamp-2 font-medium">{event.representativeArticle?.title || `Event ${event.id.slice(-8)}`}</p><div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-muted-foreground"><span>{event.articleCount} 篇</span><span>{event.representativeArticle?.source.name || "未知来源"}</span><span>{event.publicStatus === "published" ? "已公开" : "未公开"}</span><span>{event.pushedAt ? "已推送" : "未推送"}</span><span>{fullTimeLabel(event.lastSeenAt)}</span></div><div className="mt-1 flex flex-wrap gap-1"><Button size="sm" variant="outline" className="h-7 rounded-none px-1 text-xs" disabled={eventAction !== null} onClick={() => void moveCurrentArticle(event.id)}>将当前文章移至该事件</Button><Button size="sm" variant="ghost" className="h-7 rounded-none px-1 text-xs" disabled={eventAction !== null} onClick={() => setMergeTargetId(event.id)}>选择整组目标</Button></div></div>)}</div> : <p className="border border-dashed px-2.5 py-2 text-xs text-muted-foreground">{eventSearch.trim() ? "未找到匹配的目标事件。" : "输入关键词搜索目标事件。"}</p>}{mergeTargetId && <div className="flex min-w-0 items-center gap-2 border bg-sky-50 px-2 py-1.5 text-xs"><span className="min-w-0 flex-1 truncate">整组目标：{eventOptions.find((event) => event.id === mergeTargetId)?.representativeArticle?.title || mergeTargetId}</span><Button size="sm" variant="ghost" className="h-6 shrink-0 rounded-none px-1.5 text-xs" disabled={eventAction !== null} onClick={() => setMergeTargetId("")}>取消</Button><Button size="sm" variant="outline" className="h-6 shrink-0 rounded-none px-1.5 text-xs text-amber-700" disabled={eventAction !== null} onClick={() => void mergeCurrentEvent()}><Merge className="h-3 w-3" />整组并入</Button></div>}</div>
                    </TabsContent>
                  </Tabs>
                </div>
              </section>
            )}

            <details open={showSystemInfo} onToggle={(event) => setShowSystemInfo(event.currentTarget.open)} className="bg-background">
              <summary className="flex cursor-pointer list-none items-center justify-between border-b px-2.5 py-2 text-sm font-semibold"><span>系统记录与高级信息</span><span className="text-xs font-normal text-muted-foreground">Article {detail.id.slice(-8)} <ChevronDown className="inline h-3 w-3" aria-hidden="true" /></span></summary>
              <div className="space-y-2 p-2.5"><section><SectionHeader title="文章全貌" meta="低频诊断信息" /><div className="grid grid-cols-2 divide-x divide-y border-b"><div className="p-2"><div className="flex items-center gap-1.5"><Eye className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /><span className="text-xs text-muted-foreground">公开浏览</span></div><p className="mt-0.5 font-mono text-xs font-semibold tabular-nums">{detail.viewCount.toLocaleString("zh-CN")}</p></div><div className="p-2"><div className="flex items-center gap-1.5"><MousePointerClick className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /><span className="text-xs text-muted-foreground">原文点击 · {clickRate}%</span></div><p className="mt-0.5 font-mono text-xs font-semibold tabular-nums">{detail.originalClickCount.toLocaleString("zh-CN")}</p></div></div><div className="grid grid-cols-2 gap-x-3 gap-y-1 p-2.5 text-xs lg:grid-cols-3"><MetaRow label="详情处理" value={stageStatusLabel("fetch", detail.fetchStatus)} />{detail.fetchError && <MetaRow label="处理失败原因" value={detail.fetchError} />}<MetaRow label="AI 分析" value={stageStatusLabel("ai", detail.aiStatus, detail.skipReason)} />{detail.aiError && <MetaRow label="AI 失败原因" value={detail.aiError} />}<MetaRow label="事件聚类" value={stageStatusLabel("cluster", detail.clusterStatus)} />{detail.clusterError && <MetaRow label="聚类失败原因" value={detail.clusterError} />}{detail.skipReason && <MetaRow label="跳过原因" value={detail.skipReason} />}<MetaRow label="原始评分" value={detail.rawScore == null ? "—" : String(detail.rawScore)} mono /><MetaRow label="创建时间" value={fullTimeLabel(detail.createdAt)} /><MetaRow label="更新时间" value={fullTimeLabel(detail.updatedAt)} /><MetaRow label="发布时间" value={fullTimeLabel(detail.publishedAt)} /><MetaRow label="聚类时间" value={fullTimeLabel(detail.clusteredAt)} /><MetaRow label="人工修正" value={detail.manualCorrectedAt ? fullTimeLabel(detail.manualCorrectedAt) : "无"} /><MetaRow label="来源类型" value={detail.source.type} /><div className="col-span-2 min-w-0 lg:col-span-3"><MetaRow label="文章 ID" value={detail.id} mono /></div><div className="col-span-2 min-w-0 lg:col-span-3"><div className="grid min-w-0 grid-cols-[58px_minmax(0,1fr)] gap-2"><span className="text-muted-foreground">来源主页</span><a className="min-w-0 break-all underline-offset-2 hover:underline" href={detail.source.url} target="_blank" rel="noreferrer" title={detail.source.url}>{detail.source.url}</a></div></div></div>{manualOverrides.length > 0 && <div className="border-t p-2.5"><p className="text-xs font-medium text-muted-foreground">人工覆盖字段</p><div className="mt-1.5 flex flex-wrap gap-1">{manualOverrides.map((field) => <Badge key={field} variant="secondary" className="h-5 rounded-none px-1 text-xs">{manualFieldLabel(field)}</Badge>)}</div></div>}</section>
                <section className="bg-background"><button type="button" className="flex w-full items-center justify-between border-t px-0 py-1.5 text-left text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px]" onClick={() => { setShowFullContent((value) => !value); setRequestedPanel("content"); updateDetailUrl(detail.id, "content"); }}><span className="flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" aria-hidden="true" />正文核验 <span className="font-normal text-muted-foreground">{cleanContentText.length.toLocaleString("zh-CN")} 字</span></span><ChevronDown className={`h-3.5 w-3.5 transition-transform ${showFullContent ? "rotate-180" : ""}`} aria-hidden="true" /></button>{showFullContent && <div className="max-h-[220px] overflow-y-auto border-t px-2 py-1.5 text-xs leading-4 break-words whitespace-pre-line text-pretty">{cleanContentText.slice(0, 12000) || "正文尚未准备好"}</div>}</section>
                {detail.pushLogs.length > 0 && <section className="bg-background"><SectionHeader title="推送记录" meta={`${latestPushLogs.length} 个目标 · ${detail.pushLogs.length} 条记录`} /><div className="divide-y">{detail.pushLogs.map((log) => <div key={log.id} className="grid gap-0.5 px-3 py-2 text-xs sm:grid-cols-[100px_minmax(0,1fr)_68px_116px] sm:items-center sm:gap-2"><span className={`font-medium ${log.status === "success" ? "text-emerald-700" : log.status === "failed" || log.status === "failure" ? "text-red-700" : "text-amber-700"}`}>{pushStatusLabel(log.status)}{log.retryCount > 0 ? ` · 重试 ${log.retryCount}` : ""}</span><span className="min-w-0 truncate" title={log.webhookTarget}>{log.webhookRemark || log.webhookTarget || "未命名目标"}</span><span className="text-muted-foreground">{log.articleId === detail.id ? "本篇代表" : "历史代表"}</span><span className="font-mono text-xs tabular-nums text-muted-foreground sm:text-right">{fullTimeLabel(log.createdAt)}</span>{log.errorMessage && <p className="text-red-700 sm:col-span-4">{log.errorMessage}</p>}</div>)}</div></section>}
              </div>
            </details>
          </aside>

        </div>
      </div>
    </ScrollArea>
  ) : <div className="flex h-full items-center justify-center text-xs text-muted-foreground">文章不存在或尚未选择</div>;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="h-[100dvh] w-screen max-w-[100vw] min-h-0 gap-0 overflow-hidden p-0 pb-[env(safe-area-inset-bottom)] [&>[data-slot=sheet-close]]:z-10 [&>[data-slot=sheet-close]]:rounded-none [&>[data-slot=sheet-close]]:bg-background sm:w-full sm:max-w-[min(987px,65dvw)]">
        <SheetHeader className="sr-only">
          <SheetTitle>文章工作台</SheetTitle>
          <SheetDescription>内容校准、Event 修正、公开与推送</SheetDescription>
        </SheetHeader>
        <div ref={detailScrollContainerRef} className="min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/10">{detailWorkspace}</div>
      </SheetContent>
    </Sheet>
  );
}

function SectionHeader({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex min-h-7 min-w-0 items-center gap-2 border-b px-2 py-1">
      <h2 className="min-w-0 truncate text-xs font-semibold">{title}</h2>
      {meta && <span className="ml-auto min-w-0 truncate text-right text-xs text-muted-foreground">{meta}</span>}
    </div>
  );
}

function StatusBadge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "success" | "warning" | "neutral" | "representative" | "recommended";
}) {
  const className = {
    success: "border-emerald-200 bg-emerald-50 text-emerald-700",
    warning: "border-amber-200 bg-amber-50 text-amber-800",
    neutral: "border-border bg-muted/60 text-muted-foreground",
    representative: "border-sky-200 bg-sky-50 text-sky-800",
    recommended: "border-violet-200 bg-violet-50 text-violet-800",
  }[tone];
  return <span className={`inline-flex max-w-full items-center border px-1.5 py-0.5 text-[11px] font-medium leading-4 ${className}`}>{children}</span>;
}

function ScoreMetric({ label, value }: { label: string; value: ReactNode }) {
  return <div className="min-w-0 bg-background px-1.5 py-1.5"><p className="truncate text-[11px] text-muted-foreground">{label}</p><p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{value}</p></div>;
}

function DetailMetaItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 bg-background px-1.5 py-1">
      <div className="grid min-w-0 grid-cols-[50px_minmax(0,1fr)] items-start gap-1">
        <span className="whitespace-nowrap text-muted-foreground">{label}</span>
        <span className={`min-w-0 break-words ${mono ? "font-mono text-xs tabular-nums break-all" : ""}`}>{value}</span>
      </div>
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
