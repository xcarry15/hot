import type { ArticleListItemDto, ArticlePushLogDto } from "@/contracts/articles";
import type { EventAudit, EventDetail, PushTargetSummary, WorkspaceStatusTone } from "./types";
import { isBusinessSkipReason } from "@/lib/article-pipeline-status";

const EVENT_CLASSIFICATION_ACTIONS = new Set([
  "create",
  "attach",
  "fallback_create",
  "move",
  "merge",
  "split",
  "manual_create",
  "confirm_independent",
]);

const WORKSPACE_ACTION_CLASS = "min-h-7 h-auto max-w-full rounded-none px-2 text-left text-xs font-medium leading-4 whitespace-normal sm:whitespace-nowrap";
const EDITOR_FIELD_CLASS = "rounded-none border-amber-300 bg-amber-50 text-xs focus-visible:border-amber-400 focus-visible:ring-amber-400/30";

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
    return "分析完成（无价值）";
  if (item.aiStatus === "skipped") return "已跳过";
  if (item.aiStatus === "pending") return "分析中";
  if (item.clusterStatus === "failed") return "聚类失败";
  if (item.clusterStatus === "needs_review") return "聚类复核";
  return "正常";
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
        "not-event-representative": "当前文章不是事件代表文章",
        "not-publicly-eligible": "不符合公开规则",
      } as Record<string, string>
    )[reason] ?? "等待公开规则评估"
  );
}

function pushTargetSummary(states: EventDetail["pushTargetStates"]): PushTargetSummary {
  if (states.length === 0) return { label: "未配置目标", tone: "neutral" };
  const success = states.filter((state) => state.latestStatus === "success").length;
  const failure = states.filter((state) => state.latestStatus === "failure").length;
  const unknown = states.filter((state) => state.latestStatus === "unknown").length;
  if (unknown > 0) return { label: `结果未知 ${success}/${states.length}`, tone: "warning" };
  if (success === states.length) return { label: `全部成功 ${success}/${states.length}`, tone: "success" };
  if (failure === states.length) return { label: `全部失败 0/${states.length}`, tone: "danger" };
  if (success > 0) return { label: `部分成功 ${success}/${states.length}`, tone: "warning" };
  return { label: "未推送", tone: "warning" };
}

function fullTimeLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return FULL_DATE_TIME_FORMATTER.format(new Date(value));
}

function timeDistanceLabel(left: string | null | undefined, right: string | null | undefined): string {
  if (!left || !right) return "时间未知";
  const distance = Math.abs(new Date(left).getTime() - new Date(right).getTime());
  const hours = Math.floor(distance / (60 * 60 * 1000));
  if (hours < 1) return "不足 1 小时";
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days} 天 ${remainingHours} 小时` : `${days} 天`;
}

function parseEventKeyParts(eventKey: string): { subjects: string; action: string; object: string } {
  const [subjects = "—", action = "—", ...objects] = eventKey.split("/");
  return {
    subjects: subjects || "—",
    action: action || "—",
    object: objects.join("/") || "—",
  };
}

function eventKeyRelationLabel(currentEventKey: string, candidateEventKey: string): string {
  if (!currentEventKey || !candidateEventKey) return "身份信息不足";
  if (currentEventKey === candidateEventKey) return "事件键一致";
  const current = parseEventKeyParts(currentEventKey);
  const candidate = parseEventKeyParts(candidateEventKey);
  if (current.action === candidate.action && current.object === candidate.object) return "动作与事项一致";
  if (current.action === candidate.action) return "动作一致、事项不同";
  return "事件键不同";
}

function workspaceStatusClass(tone: WorkspaceStatusTone): string {
  return tone === "success"
    ? "bg-emerald-50 text-emerald-800"
    : tone === "warning"
      ? "bg-amber-50 text-amber-800"
      : tone === "danger"
        ? "bg-red-50 text-red-800"
        : tone === "accent"
          ? "bg-violet-50 text-violet-800"
          : "bg-muted/60 text-muted-foreground";
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
    move: "移动文章",
    split: "拆分文章",
    merge: "合并事件",
    manual_create: "创建独立事件",
    confirm_independent: "确认独立事件",
  } as Record<string, string>)[action] ?? action;
}

function asAuditRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function selectedAuditCandidate(audit: Pick<EventAudit, "evidence">): Record<string, unknown> | null {
  const candidates = audit.evidence.candidates;
  if (!Array.isArray(candidates)) return null;
  const records = candidates.map(asAuditRecord).filter((item): item is Record<string, unknown> => item !== null);
  const selectedId = audit.evidence.selectedCandidateEventId;
  return records.find((item) => item.candidateEventId === selectedId) ?? records[0] ?? null;
}

function clusterAuditReason(audit: Pick<EventAudit, "evidence">): string {
  const candidate = selectedAuditCandidate(audit);
  const aiDecision = asAuditRecord(audit.evidence.aiDecision) ?? asAuditRecord(candidate?.aiDecision);
  const aiReason = aiDecision?.reason;
  const reason = aiReason ?? audit.evidence.reason ?? audit.evidence.aiReason;
  return typeof reason === "string" && reason.trim() && reason !== "无补充理由"
    ? reason
    : "";
}

function clusterAuditDecisionSourceLabel(source: string): string {
  return ({ exact: "精确匹配", rule: "规则判断", ai: "AI 判断", admin: "人工确认" } as Record<string, string>)[source] ?? source;
}

function clusterAuditRelatedTitle(audit: EventAudit): string {
  const candidate = selectedAuditCandidate(audit);
  const nestedTitle = candidate?.candidateTitle;
  return audit.candidateEvent?.representativeArticle?.title
    || (typeof nestedTitle === "string" ? nestedTitle : "");
}

function clusterAuditOutcome(audit: EventAudit, articleTitle: string): string {
  const article = `《${articleTitle}》`;
  const relatedTitle = clusterAuditRelatedTitle(audit);
  const related = relatedTitle ? `《${relatedTitle}》` : "原事件";
  return ({
    create: `系统为${article}创建了当前独立事件`,
    attach: `${article}已匹配并归入当前事件${relatedTitle ? `，关联${related}` : ""}`,
    fallback_create: `系统为${article}建立待复核事件，等待人工确认`,
    representative_change: `${article}已被设为当前事件代表文章`,
    move: `人工将${article}从${related}移入当前事件`,
    split: `人工将${article}从原事件拆出`,
    merge: `${related}已整体并入当前事件`,
    manual_create: `人工将${article}从${related}拆出并建立当前事件`,
    confirm_independent: `人工确认${article}为独立事件，已解除待复核状态`,
  } as Record<string, string>)[audit.action] ?? `${clusterAuditActionLabel(audit.action)}：${article}`;
}

function clusterAuditEvidenceLabels(audit: EventAudit): string[] {
  const candidate = selectedAuditCandidate(audit);
  const candidateRule = asAuditRecord(candidate?.ruleEvidence);
  const pair = asAuditRecord(audit.evidence.pair) ?? candidateRule;
  const labels: string[] = [];
  const reason = clusterAuditReason(audit);
  if (reason) labels.push(reason);
  const eventKey = audit.evidence.eventKey ?? audit.evidence.articleEventKey;
  if (typeof eventKey === "string" && eventKey.trim()) labels.push(`事件身份 ${eventKey}`);
  const eventIdentity = asAuditRecord(audit.evidence.eventIdentity);
  if (!eventKey && eventIdentity) {
    const subjects = Array.isArray(eventIdentity.subjects) ? eventIdentity.subjects.filter((item): item is string => typeof item === "string") : [];
    const action = typeof eventIdentity.action === "string" ? eventIdentity.action : "";
    const object = typeof eventIdentity.object === "string" ? eventIdentity.object : "";
    const identity = [...subjects, action, object].filter(Boolean).join("/");
    if (identity) labels.push(`事件身份 ${identity}`);
  }
  if (pair?.fingerprintMatch === true) labels.push("正文指纹一致");
  if (pair?.exactTitle === true) labels.push("标题完全一致");
  if (pair?.eventKeyMatch === true) labels.push("事件键一致");
  if (typeof pair?.decision === "string") labels.push(({ exact: "精确命中", strong: "强关联", ambiguous: "需要判断", reject: "已排除" } as Record<string, string>)[pair.decision] ?? pair.decision);
  if (typeof pair?.identityScore === "number") labels.push(`身份相似 ${Math.round(pair.identityScore * 100)}%`);
  if (typeof pair?.titleOverlap === "number") labels.push(`标题相似 ${Math.round(pair.titleOverlap * 100)}%`);
  if (typeof pair?.daysApart === "number") labels.push(`时间间隔 ${Math.round(pair.daysApart * 10) / 10} 天`);
  if (pair?.phaseConflict === true) labels.push("事件阶段冲突");
  if (pair?.identityConflict === true) labels.push("事件身份冲突");
  if (audit.evidence.multiTopic === true) labels.push("标题包含多个独立事件");
  if (typeof audit.evidence.eventKeyConfidence === "number") labels.push(`事件身份置信度 ${audit.evidence.eventKeyConfidence}%`);
  return [...new Set(labels)].slice(0, 5);
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
      summary: "AI洞察",
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

export {
  EDITOR_FIELD_CLASS,
  EVENT_CLASSIFICATION_ACTIONS,
  WORKSPACE_ACTION_CLASS,
  articlePushStatusLabel,
  asAuditRecord,
  clusterAuditActionLabel,
  clusterAuditDecisionSourceLabel,
  clusterAuditEvidenceLabels,
  clusterAuditOutcome,
  clusterAuditReason,
  clusterAuditRelatedTitle,
  errorMessage,
  eventKeyRelationLabel,
  fullTimeLabel,
  latestPushTargetLogs,
  manualFieldLabel,
  parseEventKeyParts,
  processingLabel,
  publicReasonLabel,
  publicResultLabel,
  pushTargetSummary,
  pushStatusLabel,
  selectedAuditCandidate,
  timeDistanceLabel,
  timeLabel,
  workspaceStatusClass,
};
