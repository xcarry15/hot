/**
 * Canonical dedup evidence — 单一数据结构，所有去重阶段在判定命中时产出。
 *
 * 设计目标（第一性原理）：让用户能在文章详情区复核"是否真的重复"。
 * 复核需要的最小信息集：
 *   1. 用什么方式判的（去重方式 / 置信度）
 *   2. 和哪篇重复（标题 + URL，可跳转）
 *   3. 为什么判（一句话详情 + 共享数值）
 *   4. 两篇文章里具体重复了哪段（含前后 20 字上下文，可对比）
 *
 * 写入时机：判定命中时即刻产出（write-time），而非读取时重算。
 *   理由：被 discard 的文章正文已被删除，无法读取时再算；为与之一致，
 *   skipped 文章也在写入时固化证据。即使后续匹配文章被删，证据仍可展示。
 *
 * 展示一致性：article（dedupDetail）与 discarded（detail JSON）都存本结构，
 * 详情区用同一个 DedupEvidencePanel 渲染。
 */

export interface DedupSnippet {
  /** 本段证据的标注（如归一化数值 "43.31亿"，或 "公共片段 1"）。可选。 */
  label?: string;
  /** 当前文章中：重复段前 ~20 字 */
  currentBefore: string;
  /** 当前文章中：被判定为重复的原文片段（用于高亮） */
  currentShared: string;
  /** 当前文章中：重复段后 ~20 字 */
  currentAfter: string;
  /** 重复文章中：重复段前 ~20 字 */
  matchedBefore: string;
  /** 重复文章中：被判定为重复的原文片段（LCS 下与 currentShared 相同；数值下可能是不同写法） */
  matchedShared: string;
  /** 重复文章中：重复段后 ~20 字 */
  matchedAfter: string;
}

export interface DedupEvidence {
  /** 机器可读方式 key: url | fingerprint | title_jaccard | body_lcs | numeric | keypoints_lcs */
  methodKey: string;
  /** 人类可读去重方式 */
  method: string;
  /** 重复文章标题 */
  matchedTitle: string;
  /** 重复文章 URL */
  matchedUrl: string;
  /** 重复文章 ID（可点击跳转详情；匹配文章已删除则为空） */
  matchedId?: string;
  /** 相似度 / 置信度 0-1（fingerprint=1, jaccard=分数；纯数值/LCS 无意义则省略） */
  similarity?: number;
  /** 一句话去重详情：为什么判重 */
  detail: string;
  /** 共享数值（数值类方式） */
  sharedValues?: string[];
  /** 内容对比片段（LCS 段 / 数值出现位置），最多 5 段 */
  snippets?: DedupSnippet[];
}

/** 解析 dedupDetail / discarded.detail JSON 为 DedupEvidence；非法或非本结构返回 null。 */
export function parseDedupEvidence(raw: string | null | undefined): DedupEvidence | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (
      obj &&
      typeof obj === 'object' &&
      typeof obj.methodKey === 'string' &&
      typeof obj.method === 'string' &&
      typeof obj.detail === 'string'
    ) {
      return obj as DedupEvidence;
    }
  } catch {
    /* not JSON or malformed */
  }
  return null;
}
