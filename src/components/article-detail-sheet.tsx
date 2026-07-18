"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { ArticleDetailDto } from "@/contracts/articles";
import { fetchArticleDetail } from "@/features/articles-api.client";
import { fetchDiscardedItem } from "@/features/discarded-api.client";
import { isRequestAborted, isRequestJsonError } from "@/lib/request-json.client";
import { formatRelativeTime } from "@/lib/shared/date";
import { parseJsonArray } from "@/lib/shared/article-codecs";

interface DiscardedDetail {
  id: string;
  title: string;
  url: string;
  reason: string;
  parsedDetail: Record<string, unknown> | null;
  winnerArticleId: string | null;
  createdAt: string;
  source?: { name: string };
}

interface Props {
  articleId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArticleUpdated?: () => void;
  onSelectArticle?: (id: string) => void;
  kind?: "article" | "discarded";
  onStepAction?: (
    articleId: string,
    step: "process" | "cluster" | "ai" | "push",
  ) => Promise<boolean>;
  isJobRunning?: boolean;
}

function statusLabel(status: string | null | undefined): string {
  switch (status) {
    case "fetched":
    case "clustered":
    case "done":
    case "completed":
      return "完成";
    case "running":
    case "processing":
      return "运行中";
    case "failed":
      return "失败";
    case "skipped":
      return "已跳过";
    case "needs_review":
      return "待复核";
    case "blocked":
      return "已阻塞";
    case "filtered":
      return "已过滤";
    case "not_applicable":
      return "不适用";
    case "pending":
    default:
      return "等待";
  }
}

function processState(article: ArticleDetailDto): { label: string; failedStep: "process" | "cluster" | "ai" | "push" | null } {
  if (article.fetchStatus === "failed") return { label: "正文处理失败", failedStep: "process" };
  if (article.clusterStatus === "failed") return { label: "聚类失败", failedStep: "cluster" };
  if (article.aiStatus === "failed" || (article.aiStatus === "skipped" && article.skipReason?.startsWith("AI 连续失败"))) return { label: "AI 处理失败", failedStep: "ai" };
  if (article.aiStatus === "skipped") return { label: article.skipReason || "AI 已按业务规则跳过", failedStep: null };
  if (currentPushFailures(article).length > 0) return { label: "推送存在失败目标", failedStep: "push" };
  if (article.clusterStatus === "needs_review") return { label: "聚类待人工复核", failedStep: null };
  return { label: "流程正常", failedStep: null };
}

function currentPushFailures(article: ArticleDetailDto) {
  const latest = new Map<string, ArticleDetailDto["pushLogs"][number]>();
  for (const log of article.pushLogs) {
    const target = log.webhookTarget || log.webhookRemark;
    if (!latest.has(target)) latest.set(target, log);
  }
  return [...latest.values()].filter((log) => log.status === "failure");
}

export default function ArticleDetailSheet({
  articleId,
  open,
  onOpenChange,
  kind = "article",
  onStepAction,
  isJobRunning,
}: Props) {
  const [article, setArticle] = useState<ArticleDetailDto | null>(null);
  const [discarded, setDiscarded] = useState<DiscardedDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<{ notFound: boolean; message: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    if (!open || !articleId) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setArticle(null);
    setDiscarded(null);
    const request = kind === "discarded"
      ? fetchDiscardedItem(articleId, controller.signal).then((value) => setDiscarded(value as DiscardedDetail))
      : fetchArticleDetail(articleId, controller.signal).then(setArticle);
    request
      .catch((error) => {
        if (isRequestAborted(error)) return;
        if (isRequestJsonError(error, 404)) {
          setLoadError({ notFound: true, message: "该记录不存在或已被删除" });
          return;
        }
        setLoadError({
          notFound: false,
          message: error instanceof Error ? error.message : "详情加载失败",
        });
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [articleId, kind, open, reloadKey]);

  const state = article ? processState(article) : null;
  const pushFailures = article ? currentPushFailures(article) : [];
  const keyPoints = article ? parseJsonArray(article.keyPoints).slice(0, 5) : [];
  const retry = async () => {
    if (!articleId || !state?.failedStep || !onStepAction) return;
    setActionLoading(true);
    try { await onStepAction(articleId, state.failedStep); } finally { setActionLoading(false); }
  };
  const inboxHref = articleId
    ? `/admin?tab=articles&articleId=${encodeURIComponent(articleId)}&panel=${article?.clusterStatus === "needs_review" ? "cluster" : "content"}`
    : "/admin?tab=articles";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full p-0 sm:max-w-lg">
        <SheetHeader className="border-b p-5 pb-3">
          <SheetTitle className="text-base">{kind === "discarded" ? "未入库诊断" : "流程诊断"}</SheetTitle>
          <SheetDescription className="sr-only">查看采集与流水线技术状态</SheetDescription>
        </SheetHeader>
        <ScrollArea className="h-[calc(100dvh-68px)]">
          {loading ? <div className="space-y-3 p-5"><Skeleton className="h-6 w-3/4" /><Skeleton className="h-20 w-full" /></div> : article ? (
            <div className="space-y-4 p-5">
              <div><h3 className="font-semibold leading-snug">{article.title}</h3><p className="mt-1 text-xs text-muted-foreground">{article.source.name} · {formatRelativeTime(article.createdAt)}</p></div>
              <div className="flex flex-wrap gap-2"><Badge variant={state?.failedStep ? "destructive" : "outline"}>{state?.label}</Badge><Badge variant="outline">正文 {article.cleanContent.length} 字符</Badge><Badge variant="outline">事件 {article.event?.articleCount ?? 0} 来源</Badge></div>
              <div className="grid grid-cols-5 border text-center text-xs">
                <div className="border-r p-2">采集<br /><b>完成</b></div>
                <div className="border-r p-2">处理<br /><b>{statusLabel(article.fetchStatus)}</b></div>
                <div className="border-r p-2">聚类<br /><b>{statusLabel(article.clusterStatus)}</b></div>
                <div className="border-r p-2">AI<br /><b>{statusLabel(article.aiStatus)}</b></div>
                <div className="p-2">推送<br /><b>{pushFailures.length > 0 ? "失败" : article.pushedAt ? "完成" : "等待"}</b></div>
              </div>
              {state?.failedStep && <div className="border border-red-200 bg-red-50 p-3 text-xs text-red-800"><div className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" />当前失败：{state.label}</div>{article.skipReason && <p className="mt-2">原因：{article.skipReason}</p>}{pushFailures.slice(0, 3).map((log) => <p key={log.id} className="mt-1">{log.webhookRemark || log.webhookTarget}：{log.errorMessage || "投递失败"}（重试 {log.retryCount} 次）</p>)}</div>}
               {article.clusterStatus === "needs_review" && <p className="border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">聚类流程已完成，但业务判断存在歧义，请到情报收件箱确认独立事件或调整归属。</p>}
               <div className="flex flex-wrap gap-2"><a href={article.url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 border px-3 text-xs"><ExternalLink className="h-3.5 w-3.5" />原文</a>{state?.failedStep && <Button size="sm" variant="outline" disabled={actionLoading || isJobRunning} onClick={() => void retry()}>{actionLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}重试失败步骤</Button>}<a href={inboxHref} className="inline-flex h-8 items-center border px-3 text-xs">{article.clusterStatus === "needs_review" ? "去聚类校准" : "去情报收件箱查看内容"}</a></div>
              {article.aiStatus === "done" && (
                <div className="space-y-4 border-t pt-4">
                  <section>
                    <h4 className="text-[11px] font-medium text-muted-foreground">AI 洞察</h4>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{article.summary || article.excerpt || "暂无 AI 洞察"}</p>
                  </section>
                  <section>
                    <h4 className="text-[11px] font-medium text-muted-foreground">核心要点</h4>
                    {keyPoints.length > 0 ? (
                      <ol className="mt-1 space-y-1 text-xs leading-5 text-muted-foreground">
                        {keyPoints.map((point, index) => <li key={`${point}-${index}`}>{index + 1}. {point}</li>)}
                      </ol>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">暂无核心要点</p>
                    )}
                  </section>
                </div>
              )}
            </div>
          ) : discarded ? (
            <div className="space-y-4 p-5"><h3 className="font-semibold leading-snug">{discarded.title}</h3><p className="text-xs text-muted-foreground">{discarded.source?.name || "未知来源"} · {formatRelativeTime(discarded.createdAt)}</p><Badge variant="outline">未入库：{discarded.reason}</Badge>{discarded.parsedDetail && <pre className="overflow-auto whitespace-pre-wrap border bg-muted/30 p-3 text-xs">{JSON.stringify(discarded.parsedDetail, null, 2)}</pre>}<a href={discarded.url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 border px-3 text-xs"><ExternalLink className="h-3.5 w-3.5" />原文</a></div>
          ) : loadError ? (
            <div className="space-y-3 p-5 text-sm">
              <p className={loadError.notFound ? "text-muted-foreground" : "text-destructive"}>{loadError.message}</p>
              {!loadError.notFound && <Button size="sm" variant="outline" onClick={() => setReloadKey(value => value + 1)}>重试加载</Button>}
            </div>
          ) : <div className="p-5 text-sm text-muted-foreground">暂无详情</div>}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
