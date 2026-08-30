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
import { fetchEventDetail } from "@/features/events-api.client";
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
import {
  WORKSPACE_CANVAS_CLASS,
  WORKSPACE_SCROLL_CLASS,
  WORKSPACE_SHEET_CLASS,
} from "./intelligence-inbox/styles";

function toEditorialDraft(result: ArticleDetailDto): ArticleEditorialDraft {
  return {
    summary: result.summary,
    brand: splitBrands(result.brand).join("，"),
    category: result.category,
    eventSubjects: parseEventSubjects(result.eventSubjects).join("，"),
    eventAction: result.eventAction,
    eventObject: result.eventObject,
    keyPoints: parseJsonArray(result.keyPoints).join("\n"),
  };
}

function isArticleRevisionConflict(error: unknown): boolean {
  if (!isRequestJsonError(error, 409) || !error.body || typeof error.body !== "object") return false;
  return (error.body as { code?: unknown }).code === "article_revision_conflict";
}

function hasEditorialDraftChanges(detail: ArticleDetailDto, draft: ArticleEditorialDraft): boolean {
  return JSON.stringify(toEditorialDraft(detail)) !== JSON.stringify(draft);
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
    const currentId = selectedIdRef.current;
    if (
      articleId !== currentId
      && currentId
      && editing
      && detail?.id === currentId
      && hasEditorialDraftChanges(detail, draft)
    ) {
      if (!window.confirm("当前文章有未保存的人工修改，切换文章会丢失这些修改。确认切换吗？")) {
        onArticleChange?.(currentId, requestedPanel);
        return;
      }
    }
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
  }, [articleId, detail, draft, editing, onArticleChange, requestedPanel]);

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
        setDraft(toEditorialDraft(result));
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

  const detailIdForEvent = detail?.id;
  const currentDetailEventId = detail?.eventId;
  const loadEventDetail = useCallback(
    async (eventId: string | null | undefined, signal?: AbortSignal) => {
      const requestId = ++eventDetailRequestRef.current;
      if (!eventId) {
        setEventDetail(null);
        return;
      }
      try {
        const result = await fetchEventDetail(eventId, detailIdForEvent, signal);
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
    [detailIdForEvent],
  );

  const refreshArticleDetail = useCallback(async (articleId: string) => {
    invalidateArticleDetailCache(articleId);
    const updated = await fetchArticleDetail(articleId);
    if (selectedIdRef.current === articleId) setDetail(updated);
    return updated;
  }, []);

  const refreshSelectedEvent = useCallback(async (updated: ArticleDetailDto) => {
    if (selectedIdRef.current !== updated.id || updated.eventId !== currentDetailEventId) return;
    await loadEventDetail(updated.eventId);
  }, [currentDetailEventId, loadEventDetail]);

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
    if (rowSavingId !== null || detailAction !== null || eventAction !== null) return;
    if (nextArticleId === selectedId) {
      if (panel !== undefined) setRequestedPanel(panel);
      return;
    }
    if (editing && detail && hasEditorialDraftChanges(detail, draft)) {
      if (!window.confirm("当前文章有未保存的人工修改，切换文章会丢失这些修改。确认切换吗？")) return;
    }
    setEditing(false);
    setSelectedId(nextArticleId);
    if (panel !== undefined) setRequestedPanel(panel);
    onArticleChange?.(nextArticleId, panel);
  }, [detail, detailAction, draft, editing, eventAction, onArticleChange, rowSavingId, selectedId]);

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
        .catch(async (error) => {
          if (isArticleRevisionConflict(error)) {
            try {
              await refreshArticleDetail(id);
            } catch {
              // 主错误仍由下面的提示交代，避免刷新失败覆盖冲突原因。
            }
            toast.warning("文章已被其他操作更新，已刷新当前版本");
            return;
          }
          toast.error(errorMessage(error, "更新失败"));
        })
        .finally(() => {
          rowSavingRef.current = null;
          setRowSavingId(null);
        })
        .then(() => undefined);
    },
    [patchRow, refreshAfterMutation, refreshArticleDetail, refreshSelectedEvent],
  );

  const changePublicOverride = useCallback((next: "auto" | "public" | "hidden") => {
    if (!detail || rowSavingId === detail.id || detailAction !== null || eventAction !== null || editing || next === detail.publicOverride) return;
    if (
      next === "hidden" &&
      !window.confirm("确认隐藏文章？\n\n该操作会强制覆盖自动公开策略；如果当前文章是事件代表，事件公开状态会立即重新计算。")
    ) return;
    queueRowUpdate(
      detail.id,
      { publicOverride: next, expectedUpdatedAt: detail.updatedAt },
      next === "hidden" ? "文章已隐藏" : next === "public" ? "已设为强制公开" : "已恢复自动公开策略",
    );
  }, [detail, detailAction, editing, eventAction, queueRowUpdate, rowSavingId]);

  const saveEditorial = useCallback(async () => {
    if (!selectedId || detail?.id !== selectedId || rowSavingRef.current || eventAction !== null) return;
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
        expectedUpdatedAt: detail.updatedAt,
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
      if (isArticleRevisionConflict(error)) {
        try {
          const latest = await refreshArticleDetail(selectedId);
          setDraft(toEditorialDraft(latest));
          setEditing(false);
          toast.warning("文章已被其他操作更新，已刷新当前版本，请重新确认修改");
        } catch {
          toast.error("文章已被其他操作更新，请刷新后重试");
        }
        return;
      }
      toast.error(errorMessage(error, "保存失败"));
    } finally {
      setDetailAction(null);
    }
  }, [detail, draft, eventAction, patchRow, refreshAfterMutation, refreshArticleDetail, refreshSelectedEvent, selectedId]);

  const startWorkflow = useCallback(async (startAt: "process" | "ai" | "cluster") => {
    if (!detail || detailAction || rowSavingId !== null || eventAction !== null || editing) return;
    const label = startAt === "process"
      ? "重新获取全文并重跑"
      : startAt === "ai"
        ? "重新生成 AI 结果"
        : "重新计算事件归属";
    if (
      !window.confirm(
        startAt === "process"
          ? "当前事件归属和 AI 结果将被重置，并从全文获取开始连续重跑。确认继续吗？"
          : startAt === "ai"
            ? "将重新生成 AI 结果，人工覆盖字段会保留。确认继续吗？"
            : "将按当前 AI 结果重新计算事件归属，可能归入已有事件或建立新的独立 Event。确认继续吗？",
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
  }, [detail, detailAction, editing, eventAction, refreshAfterMutation, rowSavingId]);

  const handleReviewWorkflow = useCallback((startAt: "process" | "ai") => {
    void startWorkflow(startAt);
  }, [startWorkflow]);

  const handleClusterWorkflow = useCallback(() => {
    void startWorkflow("cluster");
  }, [startWorkflow]);

  const handleConfirmIndependent = useCallback(() => {
    void confirmIndependent();
  }, [confirmIndependent]);

  const handleSplitArticles = useCallback((articleIds: string[]) => {
    void splitArticles(articleIds);
  }, [splitArticles]);

  const handleSearchEvents = useCallback((query?: string) => {
    void searchEvents(query);
  }, [searchEvents]);

  const handleMoveCurrentArticle = useCallback((eventId: string) => {
    void moveCurrentArticle(eventId);
  }, [moveCurrentArticle]);

  const handleMergeCurrentEvent = useCallback(() => {
    void mergeCurrentEvent();
  }, [mergeCurrentEvent]);

  const toggleEditing = useCallback(() => {
    setEditing((value) => !value);
  }, []);

  const handleEventSearchChange = useCallback((value: string) => {
    setEventSearch(value);
    setEventOptions([]);
    setMergeTargetId("");
  }, []);

  const handleSaveEditorial = useCallback(() => {
    void saveEditorial();
  }, [saveEditorial]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen && editing && detail && hasEditorialDraftChanges(detail, draft)) {
      if (!window.confirm("当前文章有未保存的人工修改，关闭后会丢失。确认关闭吗？")) return;
    }
    if (!nextOpen) setEditing(false);
    onOpenChange?.(nextOpen);
  }, [detail, draft, editing, onOpenChange]);

  const toggleFullContent = useCallback(() => {
    setShowFullContent((value) => !value);
    setRequestedPanel("content");
    if (detail) updateDetailUrl(detail.id, "content");
  }, [detail, updateDetailUrl]);

  const workspace = useMemo(
    () => detail ? createArticleWorkspaceViewModel(detail, eventDetail) : null,
    [detail, eventDetail],
  );
  const brandCandidates = useMemo(
    () => workspace?.brandCandidates ?? [],
    [workspace?.brandCandidates],
  );
  const eventArticleModels = useMemo(
    () => createEventArticleModels({
      detail,
      eventDetail,
      eventMembers: workspace?.eventMembers ?? [],
      brandCandidates,
      selectedSplitIds,
      interactionPending: detailAction !== null || rowSavingId !== null || eventAction !== null || editing,
      recommendedEventId,
      recommendedEvent,
      recommendedAudit,
      setComparisonTarget,
      setRepresentative,
      splitArticle,
      toggleSplitSelection,
      moveCurrentArticleToEvent,
      moveBrandCandidate,
      moveCurrentArticleToBrandEvent,
      selectArticle,
    }),
    [
      brandCandidates,
      detail,
      detailAction,
      eventAction,
      editing,
      eventDetail,
      moveBrandCandidate,
      moveCurrentArticleToBrandEvent,
      moveCurrentArticleToEvent,
      recommendedAudit,
      recommendedEvent,
      recommendedEventId,
      rowSavingId,
      selectArticle,
      selectedSplitIds,
      setComparisonTarget,
      setRepresentative,
      splitArticle,
      toggleSplitSelection,
      workspace?.eventMembers,
    ],
  );
  const { brandCandidateModels, eventMemberModels, recommendedEventModels } = eventArticleModels;
  const reviewInteractionPending = detailAction !== null || rowSavingId !== null || eventAction !== null || editing;
  const detailWorkspace = detailLoading ? (
    <div className="space-y-2 p-3 lg:p-4">
      <Skeleton className="h-28 w-full rounded-none" />
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1.18fr)_minmax(360px,0.82fr)]">
        <Skeleton className="h-[520px] w-full rounded-none" />
        <Skeleton className="h-[520px] w-full rounded-none" />
      </div>
    </div>
  ) : detail && workspace ? (
    <ScrollArea className={WORKSPACE_SCROLL_CLASS}>
      <div className={WORKSPACE_CANVAS_CLASS}>
        <ArticleWorkspaceHeader
          detail={detail}
          brands={workspace.brands}
          contentLength={workspace.cleanContentText.length}
          manualOverrides={workspace.manualOverrides}
          clickRate={workspace.clickRate}
          isRepresentative={workspace.isRepresentative}
          currentConclusion={workspace.currentConclusion}
          detailActionPending={reviewInteractionPending}
          editing={editing}
          onToggleEditing={toggleEditing}
        />

        <div className="min-w-0 space-y-3">
          <main className="min-w-0 space-y-3">
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
              onPushEvent={pushCurrentEvent}
              onStartWorkflow={handleReviewWorkflow}
              onDraftChange={updateDraft}
              onSaveEditorial={handleSaveEditorial}
            />
          </main>

          <aside className="min-w-0 space-y-3">
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
              eventActionPending={reviewInteractionPending}
              eventSearch={eventSearch}
              eventOptions={eventOptions}
              mergeTargetId={mergeTargetId}
              onConfirmIndependent={handleConfirmIndependent}
              onAutoCluster={handleClusterWorkflow}
              onSplitArticles={handleSplitArticles}
              onEventSearchChange={handleEventSearchChange}
              onSearchEvents={handleSearchEvents}
              onMoveCurrentArticle={handleMoveCurrentArticle}
              onMergeTargetChange={setMergeTargetId}
              onMergeCurrentEvent={handleMergeCurrentEvent}
            />
          </aside>

          <ArticleWorkspaceSupportPanels
            detail={detail}
            cleanContentText={workspace.cleanContentText}
            latestPushLogs={workspace.latestPushLogs}
            showFullContent={showFullContent}
            onToggleFullContent={toggleFullContent}
          />
        </div>
      </div>
    </ScrollArea>
  ) : <div className="flex h-full items-center justify-center text-xs text-muted-foreground">文章不存在或尚未选择</div>;

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className={WORKSPACE_SHEET_CLASS}>
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
