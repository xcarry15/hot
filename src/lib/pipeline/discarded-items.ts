/**
 * DiscardedItem 写入助手。
 *
 * 单一职责：把采集/抓取/AI 阶段判定"被丢弃"的文章或抓取项写入
 * `discardedItem` 表，dedup:* 与 filter:* 两种 reason 都由本模块统一收敛。
 *
 * 历史：
 *   - 逻辑原先内联在 `crawler.ts.recordDiscardedItem`；
 *   - B12 抽离后保持语义完全一致：
 *     · 用 (url, reason) 做 upsert，第一次保留 detail，后续视为同一条去重
 *     · url 截断 1000、title 截断 500
 *     · detail 为对象时 JSON.stringify，为 falsy 时写空串
 *     · publishedAt 走 parseChineseDate 解析
 *     · 失败仅 console.error，并返回 false 让调用方避免删除原文章
 */
import { db } from '@/lib/db';
import type { DedupEvidence } from '@/lib/dedup-evidence';
import { parseChineseDate } from '@/lib/date-utils';

export interface DiscardedItemInput {
  sourceId: string;
  title: string;
  url: string;
  reason: string;
  /** JSON 序列化写入 discarded.detail。dedup:* 存 canonical DedupEvidence，filter:* 存自由字段 */
  detail?: Record<string, unknown> | DedupEvidence;
  publishedAt?: string;
  /** 命中去重时指向「赢家」Article.id；filter 拒绝则不传 */
  winnerArticleId?: string;
}

/**
 * upsert (url, reason)；已存在则更新最近一次判定证据，避免管理员看到过期匹配信息。
 */
export async function recordDiscardedItem(input: DiscardedItemInput): Promise<boolean> {
  try {
    await db.discardedItem.upsert({
      where: { url_reason: { url: input.url.slice(0, 1000), reason: input.reason } },
      create: {
        sourceId: input.sourceId,
        title: input.title.slice(0, 500),
        url: input.url.slice(0, 1000),
        reason: input.reason,
        detail: input.detail ? JSON.stringify(input.detail) : '',
        winnerArticleId: input.winnerArticleId,
        publishedAt: input.publishedAt ? parseChineseDate(input.publishedAt) : undefined,
      },
      update: {
        sourceId: input.sourceId,
        title: input.title.slice(0, 500),
        detail: input.detail ? JSON.stringify(input.detail) : undefined,
        winnerArticleId: input.winnerArticleId,
        publishedAt: input.publishedAt ? parseChineseDate(input.publishedAt) : undefined,
      },
    });
    return true;
  } catch (err) {
    // 审计写入失败时不能继续删除 Article，否则会造成不可恢复的数据丢失。
    console.error('[recordDiscardedItem] failed:', err);
    return false;
  }
}
