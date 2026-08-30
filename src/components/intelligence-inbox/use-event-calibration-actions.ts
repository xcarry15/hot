'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';
import type { ArticleDetailDto } from '@/contracts/articles';
import {
  confirmEventIndependent,
  mergeEvents,
  moveEventArticle,
  pushEvent,
  searchActiveEvents,
  splitEventArticles,
  updateEventRepresentative,
} from '@/features/events-api.client';
import { invalidateArticleDetailCache } from '@/features/articles-api.client';
import type { EventDetail, EventOption } from './types';
import { errorMessage, timeLabel } from './utils';

interface UseEventCalibrationActionsOptions {
  detail: ArticleDetailDto | null;
  eventDetail: EventDetail | null;
  eventAction: string | null;
  eventOptions: EventOption[];
  mergeTargetId: string;
  eventSearch: string;
  eventSearchRequestRef: { current: number };
  selectedIdRef: { current: string | null };
  setEventAction: (value: string | null) => void;
  setEventOptions: (value: EventOption[]) => void;
  setMergeTargetId: (value: string) => void;
  setEventSearch: (value: string) => void;
  setSelectedSplitIds: (value: Set<string>) => void;
  refreshArticleDetail: (articleId: string) => Promise<ArticleDetailDto>;
  refreshSelectedEvent: (updated: ArticleDetailDto) => Promise<void>;
  refreshAfterMutation: () => void;
}

export function useEventCalibrationActions({
  detail,
  eventDetail,
  eventAction,
  eventOptions,
  mergeTargetId,
  eventSearch,
  eventSearchRequestRef,
  selectedIdRef,
  setEventAction,
  setEventOptions,
  setMergeTargetId,
  setEventSearch,
  setSelectedSplitIds,
  refreshArticleDetail,
  refreshSelectedEvent,
  refreshAfterMutation,
}: UseEventCalibrationActionsOptions) {
  const refreshCurrentArticle = useCallback(async () => {
    if (!detail) return null;
    const updated = await refreshArticleDetail(detail.id);
    await refreshSelectedEvent(updated);
    refreshAfterMutation();
    return updated;
  }, [detail, refreshAfterMutation, refreshArticleDetail, refreshSelectedEvent]);

  const setRepresentative = useCallback(async (articleId: string) => {
    if (!detail?.eventId || eventAction) return;
    setEventAction('representative');
    try {
      await updateEventRepresentative(detail.eventId, articleId);
      await refreshCurrentArticle();
      toast.success('代表文章已更新');
    } catch (error) {
      toast.error(errorMessage(error, '指定代表文章失败'));
    } finally {
      setEventAction(null);
    }
  }, [detail, eventAction, refreshCurrentArticle, setEventAction]);

  const splitArticles = useCallback(async (articleIds: string[]) => {
    if (
      !detail?.eventId
      || eventAction
      || articleIds.length === 0
      || articleIds.length >= (eventDetail?.articleCount ?? 0)
    ) return;

    const titles = eventDetail?.articles
      .filter((article) => articleIds.includes(article.id))
      .map((article) => article.title) ?? [];
    if (!window.confirm(
      `确认将 ${articleIds.length} 篇文章移出当前事件并新建独立事件？\n${titles.slice(0, 3).join('\n')}${titles.length > 3 ? `\n等 ${titles.length} 篇` : ''}\n\n历史推送不会撤回，新事件默认不会补推。`,
    )) return;

    setEventAction(`split:${articleIds.join(',')}`);
    try {
      await splitEventArticles(detail.eventId, articleIds);
      for (const articleId of articleIds) {
        if (articleId !== detail.id) invalidateArticleDetailCache(articleId);
      }
      setSelectedSplitIds(new Set());
      await refreshCurrentArticle();
      toast.success(`${articleIds.length} 篇文章已拆分为新事件，默认不会补推`);
    } catch (error) {
      toast.error(errorMessage(error, '拆分事件失败'));
    } finally {
      setEventAction(null);
    }
  }, [detail, eventAction, eventDetail, refreshCurrentArticle, setEventAction, setSelectedSplitIds]);

  const splitArticle = useCallback((articleId: string) => splitArticles([articleId]), [splitArticles]);

  const mergeCurrentEvent = useCallback(async () => {
    const targetEventId = mergeTargetId.trim();
    if (!detail?.eventId || !targetEventId || eventAction) return;
    const target = eventOptions.find((event) => event.id === targetEventId);
    if (!target) {
      setMergeTargetId('');
      toast.info('合并目标已失效，请重新搜索并选择');
      return;
    }
    if (!window.confirm(
      `确认将当前整个事件（${eventDetail?.articleCount ?? 0} 篇）并入目标事件？\n\n目标事件：${target?.representativeArticle?.title || targetEventId}\n\n当前事件会停止独立展示，历史推送不会撤回。`,
    )) return;

    setEventAction('merge');
    try {
      await mergeEvents(detail.eventId, targetEventId);
      setMergeTargetId('');
      await refreshCurrentArticle();
      toast.success('事件已合并，不会补推或撤回历史消息');
    } catch (error) {
      toast.error(errorMessage(error, '合并事件失败'));
    } finally {
      setEventAction(null);
    }
  }, [detail, eventAction, eventDetail, eventOptions, mergeTargetId, refreshCurrentArticle, setEventAction, setMergeTargetId]);

  const searchEvents = useCallback(async (query = eventSearch) => {
    if (!detail?.eventId || eventAction) return;
    const requestId = ++eventSearchRequestRef.current;
    try {
      const result = await searchActiveEvents(query, detail.eventId);
      if (requestId !== eventSearchRequestRef.current) return;
      setEventOptions(result);
    } catch (error) {
      if (requestId !== eventSearchRequestRef.current) return;
      toast.error(errorMessage(error, '事件搜索失败'));
    }
  }, [detail, eventAction, eventSearch, eventSearchRequestRef, setEventOptions]);

  const moveCurrentArticleToEvent = useCallback(async (
    targetEventId: string,
    targetLabel: string,
    actionKey = 'move',
  ) => {
    if (!detail?.eventId || eventAction || !targetEventId) return;
    const currentEventLabel = eventDetail?.articles.find((article) => article.id === eventDetail.representativeArticleId)?.eventKey
      || detail.eventKey
      || detail.title;
    if (!window.confirm(
      `确认将当前文章移至其他事件？\n\n当前事件：${currentEventLabel}\n目标事件：${targetLabel}\n\n移动后，当前文章将不再属于原事件；两边的代表文章和公开状态会自动重新计算。`,
    )) return;

    setEventAction(actionKey);
    try {
      await moveEventArticle(detail.eventId, detail.id, targetEventId);
      setEventOptions([]);
      setMergeTargetId('');
      setEventSearch('');
      await refreshCurrentArticle();
      toast.success('当前文章已移至目标事件');
    } catch (error) {
      toast.error(errorMessage(error, '移动文章失败'));
    } finally {
      setEventAction(null);
    }
  }, [detail, eventAction, eventDetail, refreshCurrentArticle, setEventAction, setEventOptions, setEventSearch, setMergeTargetId]);

  const moveCurrentArticle = useCallback(async (targetEventId: string) => {
    const target = eventOptions.find((event) => event.id === targetEventId);
    await moveCurrentArticleToEvent(
      targetEventId,
      target?.representativeArticle?.title || targetEventId,
    );
  }, [eventOptions, moveCurrentArticleToEvent]);

  const moveBrandCandidate = useCallback(async (candidate: EventDetail['brandCandidates'][number]) => {
    if (!detail?.eventId || !eventDetail || eventAction) return;
    if (!window.confirm(
      `确认将候选文章并入当前事件？\n\n候选文章：${candidate.title}\n当前事件：${detail.eventKey || detail.title}\n\n操作后，候选文章将离开原事件并成为当前事件成员；两边的代表文章和公开状态会自动重新计算。`,
    )) return;

    setEventAction(`move-candidate:${candidate.id}`);
    try {
      await moveEventArticle(candidate.eventId, candidate.id, eventDetail.id);
      await refreshCurrentArticle();
      toast.success('候选文章已并入当前事件');
    } catch (error) {
      toast.error(errorMessage(error, '移动同品牌候选失败'));
    } finally {
      setEventAction(null);
    }
  }, [detail, eventAction, eventDetail, refreshCurrentArticle, setEventAction]);

  const moveCurrentArticleToBrandEvent = useCallback(async (candidate: EventDetail['brandCandidates'][number]) => {
    if (!detail?.eventId || !eventDetail || eventAction) return;
    await moveCurrentArticleToEvent(
      candidate.eventId,
      candidate.title,
      `move-current-brand:${candidate.id}`,
    );
  }, [detail, eventAction, eventDetail, moveCurrentArticleToEvent]);

  const confirmIndependent = useCallback(async () => {
    if (!detail?.eventId || eventAction) return;
    setEventAction('confirm');
    try {
      await confirmEventIndependent(detail.eventId, detail.id);
      await refreshCurrentArticle();
      toast.success('已确认这是独立事件');
    } catch (error) {
      toast.error(errorMessage(error, '确认失败'));
    } finally {
      setEventAction(null);
    }
  }, [detail, eventAction, refreshCurrentArticle, setEventAction]);

  const pushCurrentEvent = useCallback(async (mode: 'manual' | 'repush') => {
    if (!detail?.eventId || !eventDetail || eventAction) return;
    const actionLabel = mode === 'repush' ? '完整重新推送' : '强制推送';
    if (!window.confirm(
      `${actionLabel}：${detail.title}\n事件共 ${eventDetail.articleCount} 个来源${eventDetail.pushedAt ? `，上次推送 ${timeLabel(eventDetail.pushedAt)}` : ''}。${mode === 'manual' ? '本次会绕过评分、相关度和自动推送开关，但仍要求聚类及 AI 已完成。' : '本次会向全部启用目标再次发送。'}确认继续吗？`,
    )) return;

    setEventAction('push');
    try {
      const result = await pushEvent(detail.eventId, mode);
      if (selectedIdRef.current === detail.id) await refreshCurrentArticle();
      else refreshAfterMutation();
      toast.success(result.message || `${actionLabel}完成`);
    } catch (error) {
      toast.error(errorMessage(error, '事件推送失败'));
    } finally {
      setEventAction(null);
    }
  }, [detail, eventAction, eventDetail, refreshAfterMutation, refreshCurrentArticle, selectedIdRef, setEventAction]);

  return {
    confirmIndependent,
    mergeCurrentEvent,
    moveBrandCandidate,
    moveCurrentArticle,
    moveCurrentArticleToBrandEvent,
    moveCurrentArticleToEvent,
    pushCurrentEvent,
    searchEvents,
    setRepresentative,
    splitArticle,
    splitArticles,
  };
}
