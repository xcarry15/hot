"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { ArticleDetailDto } from "@/contracts/articles";
import {
  fetchArticleDetail,
  invalidateArticleDetailCache,
  triggerArticleWorkflow,
  updateArticleEditorial,
} from "@/features/articles-api.client";
import { isRequestAborted, isRequestJsonError } from "@/lib/request-json.client";
import {
  parseJsonArray,
  splitBrands,
} from "@/lib/shared/article-codecs";
import { parseEventSubjects } from "@/contracts/event-identity";
import type {
  ArticleEditorialDraft,
  ComparisonTarget,
  DetailPanel,
  EventDetail,
  EventOption,
} from "./intelligence-inbox/types";
import { useEventCalibrationActions } from "./intelligence-inbox/use-event-calibration-actions";
import { createEventArticleModels } from "./intelligence-inbox/event-article-models";
import { errorMessage } from "./intelligence-inbox/utils";
import { ArticleComparisonDialog } from "./intelligence-inbox/workspace-primitives";
import { ArticleWorkspaceHeader } from "./intelligence-inbox/article-workspace-header";
import { ArticleReviewPanel } from "./intelligence-inbox/article-review-panel";
import { ArticleWorkspaceSupportPanels } from "./intelligence-inbox/article-workspace-support-panels";
import { EventCalibrationPanel } from "./intelligence-inbox/event-calibration-panel";
import { createArticleWorkspaceViewModel } from "./intelligence-inbox/workspace-view-model";



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
  const [requestedPanel, setRequestedPanel] = useState<DetailPanel | null>(null);
  const [eventDetail, setEventDetail] = useState<EventDetail | null>(null);
  const [eventAction, setEventAction] = useState<string | null>(null);
  const [selectedSplitIds, setSelectedSplitIds] = useState<Set<string>>(() => new Set());
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [eventSearch, setEventSearch] = useState("");
  const [comparisonTarget, setComparisonTarget] = useState<ComparisonTarget | null>(null);
  const [eventOptions, setEventOptions] = useState<EventOption[]>([]);
  const [draft, setDraft] = useState<ArticleEditorialDraft>({
    summary: "",
    brand: "",
    category: "",
    eventSubjects: "",
    eventAction: "",
    eventObject: "",
    keyPoints: "",
  });
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
    setComparisonTarget(null);
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
    if (requestedPanel === "content") {
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
    setComparisonTarget(null);
  }, [detail?.eventId]);

  const {
    confirmIndependent, mergeCurrentEvent, moveBrandCandidate, moveCurrentArticle,
    moveCurrentArticleToBrandEvent, moveCurrentArticleToEvent, pushCurrentEvent,
    searchEvents, setRepresentative, splitArticle, splitArticles,
  } = useEventCalibrationActions({
    detail, eventDetail, eventAction, eventOptions, mergeTargetId, eventSearch,
    eventSearchRequestRef, selectedIdRef, setEventAction, setEventOptions,
    setMergeTargetId, setEventSearch, setSelectedSplitIds, refreshArticleDetail,
    refreshSelectedEvent, refreshAfterMutation,
  });

  const recommendedAudit = eventDetail?.audits.find(
    (audit) =>
      audit.articleId === detail?.id &&
      audit.actor === "system" &&
      (audit.action === "create" || audit.action === "fallback_create") &&
      audit.candidateEventId !== eventDetail?.id &&
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
        toast.info("当前事件至少需要保留一篇文章");
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

  const updateDraft = useCallback((patch: Partial<ArticleEditorialDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

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

  const changePublicOverride = (next: "auto" | "public" | "hidden") => {
    if (!detail || rowSavingId === detail.id || next === detail.publicOverride) return;
    if (
      next === "hidden" &&
      !window.confirm("确认隐藏文章？\n\n该操作会强制覆盖自动公开策略；如果当前文章是事件代表，事件公开状态会立即重新计算。")
    ) return;
    queueRowUpdate(
      detail.id,
      { publicOverride: next },
      next === "hidden" ? "文章已隐藏" : next === "public" ? "已设为强制公开" : "已恢复自动公开策略",
    );
  };

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

  const startWorkflow = async (startAt: "process" | "ai" | "cluster") => {
    if (!detail || detailAction) return;
    const label = startAt === "process"
      ? "重新获取全文并重跑"
      : startAt === "ai"
        ? "重新生成 AI 结果"
        : "自动建立独立事件";
    if (
      !window.confirm(
        startAt === "process"
          ? "当前事件归属和 AI 结果将被重置，并从全文获取开始连续重跑。确认继续吗？"
          : startAt === "ai"
            ? "将重新生成 AI 结果，人工覆盖字段会保留。确认继续吗？"
            : "将按当前 AI 结果重新计算事件归属；没有完整事件身份的文章会自动建立独立 Event，不再进入人工复核。确认继续吗？",
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

  const workspace = useMemo(
    () => detail ? createArticleWorkspaceViewModel(detail, eventDetail) : null,
    [detail, eventDetail],
  );
  const brandCandidates = workspace?.brandCandidates ?? [];
  const { brandCandidateModels, eventMemberModels, recommendedEventModels } = createEventArticleModels({
    detail, eventDetail, eventMembers: workspace?.eventMembers ?? [], brandCandidates, selectedSplitIds, eventAction,
    recommendedEventId, recommendedEvent, recommendedAudit,
    setComparisonTarget, setRepresentative, splitArticle, toggleSplitSelection,
    moveCurrentArticleToEvent, moveBrandCandidate, moveCurrentArticleToBrandEvent, selectArticle,
  });
  const detailWorkspace = detailLoading ? (
    <div className="space-y-2 p-3 lg:p-4">
      <Skeleton className="h-28 w-full rounded-none" />
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1.18fr)_minmax(360px,0.82fr)]">
        <Skeleton className="h-[520px] w-full rounded-none" />
        <Skeleton className="h-[520px] w-full rounded-none" />
      </div>
    </div>
  ) : detail && workspace ? (
    <ScrollArea className="h-full w-full min-w-0 overscroll-contain [&>[data-radix-scroll-area-viewport]]:overflow-x-hidden">
      <div className="mx-auto w-full min-w-0 max-w-[1080px] space-y-2 bg-muted/20 p-0 sm:p-2">
        <ArticleWorkspaceHeader
          detail={detail}
          brands={workspace.brands}
          manualOverrides={workspace.manualOverrides}
          clickRate={workspace.clickRate}
          isRepresentative={workspace.isRepresentative}
          currentConclusion={workspace.currentConclusion}
          detailActionPending={detailAction !== null}
          editing={editing}
          onToggleEditing={() => setEditing((value) => !value)}
        />

        <div className="min-w-0 space-y-2">
          <main className="min-w-0 space-y-2">
            <ArticleReviewPanel
              detail={detail}
              keyPoints={workspace.keyPoints}
              releaseStatus={workspace.releaseStatus}
              pushSummary={workspace.pushSummary}
              releaseGateMessage={workspace.releaseGateMessage}
              isRepresentative={workspace.isRepresentative}
              canForcePush={workspace.canForcePush}
              eventPushedAt={eventDetail?.pushedAt}
              rowSaving={rowSavingId === detail.id}
              eventActionPending={eventAction !== null}
              detailAction={detailAction}
              editing={editing}
              draft={draft}
              onChangePublicOverride={changePublicOverride}
              onPushEvent={(mode) => void pushCurrentEvent(mode)}
              onStartWorkflow={(startAt) => void startWorkflow(startAt)}
              onDraftChange={updateDraft}
              onSaveEditorial={() => void saveEditorial()}
            />
          </main>

          <aside className="min-w-0 space-y-2">
            <EventCalibrationPanel
              detail={detail}
              eventDetail={eventDetail}
              eventSourceCount={workspace.eventSourceCount}
              eventMemberModels={eventMemberModels}
              recommendedEventModels={recommendedEventModels}
              brandCandidateModels={brandCandidateModels}
              currentArticleClassificationAudit={workspace.currentArticleClassificationAudit}
              eventArticleTitles={workspace.eventArticleTitles}
              selectedSplitIds={selectedSplitIds}
              eventActionPending={eventAction !== null}
              eventSearch={eventSearch}
              eventOptions={eventOptions}
              mergeTargetId={mergeTargetId}
              onConfirmIndependent={() => void confirmIndependent()}
              onAutoCluster={() => void startWorkflow("cluster")}
              onSplitArticles={(articleIds) => void splitArticles(articleIds)}
              onEventSearchChange={(value) => setEventSearch(value)}
              onSearchEvents={(query) => void searchEvents(query)}
              onMoveCurrentArticle={(eventId) => void moveCurrentArticle(eventId)}
              onMergeTargetChange={(eventId) => setMergeTargetId(eventId)}
              onMergeCurrentEvent={() => void mergeCurrentEvent()}
            />
          </aside>

          <ArticleWorkspaceSupportPanels
            detail={detail}
            cleanContentText={workspace.cleanContentText}
            latestPushLogs={workspace.latestPushLogs}
            showFullContent={showFullContent}
            onToggleFullContent={() => {
              setShowFullContent((value) => !value);
              setRequestedPanel("content");
              updateDetailUrl(detail.id, "content");
            }}
          />
        </div>
      </div>
    </ScrollArea>
  ) : <div className="flex h-full items-center justify-center text-xs text-muted-foreground">文章不存在或尚未选择</div>;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="h-[100dvh] w-screen max-w-[100vw] min-h-0 gap-0 overflow-hidden p-0 pb-[env(safe-area-inset-bottom)] [&>[data-slot=sheet-close]]:z-10 [&>[data-slot=sheet-close]]:rounded-none [&>[data-slot=sheet-close]]:bg-background sm:w-full sm:max-w-[min(1100px,78dvw)]">
          <SheetHeader className="sr-only">
            <SheetTitle>文章审核与事件校准工作台</SheetTitle>
            <SheetDescription>内容校准、事件修正、公开与推送</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/10">{detailWorkspace}</div>
        </SheetContent>
      </Sheet>
      <ArticleComparisonDialog
        detail={detail}
        target={comparisonTarget}
        onOpenChange={(nextOpen) => { if (!nextOpen) setComparisonTarget(null); }}
        onMoveCurrent={() => {
          if (!comparisonTarget) return;
          const target = comparisonTarget;
          setComparisonTarget(null);
          void moveCurrentArticleToEvent(target.eventId, target.title, `compare-move:${target.eventId}`);
        }}
        onMergeCandidate={() => {
          if (!comparisonTarget?.articleId) return;
          const candidate = brandCandidates.find((item) => item.id === comparisonTarget.articleId);
          setComparisonTarget(null);
          if (candidate) void moveBrandCandidate(candidate);
        }}
      />
    </>
  );
}
