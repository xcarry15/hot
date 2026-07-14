/**
 * 飞书卡片构建器（纯函数，可独立测试）。
 *
 * 与 transport / delivery 解耦：把 article 元信息映射到 Feishu interactive card
 * JSON。无 I/O，可被任意上下文调用。
 *
 * 设计要点：
 *   - 单个 lark_md 块承载元信息 + 要点 + 洞察，避免多 div/hr 撑高卡片
 *   - header template 复用 getScoreStyle 的六色段位 + urgent 时升 red
 *   - 时间紧凑格式 MM-DD HH:mm（中文环境）
 *   - 近期关联动态块（实际时间窗口 30 天）后置，title 截 50 字 + … 控制高度
 *   - 标题后缀 [软文] 仅 isAd=true 时附加（与 aiStatus='done' 契约一致）
 */
import { parseJsonArray, parseTags, splitBrands } from '@/lib/shared/article-codecs';
import { formatRelativeTime } from '@/lib/shared/date';
import { getScoreStyle } from '@/lib/shared/score-style';

export type PushUrgency = 'urgent' | 'normal';

export interface FeishuCardArticleInput {
  title: string;
  summary: string;
  brand: string;
  category: string;
  score: number;
  relevance: number;
  tags: string;
  keyPoints: string;
  url: string;
  aiStatus: string;
  isAd: boolean;
  createdAt?: string | Date;
  originalSource?: string | null;
  source?: { name: string };
}

export interface FeishuCardRelated {
  title: string;
  score: number;
  createdAt: Date | string;
  publishedAt?: Date | string | null;
}

export interface FeishuCardOptions {
  relatedArticles?: FeishuCardRelated[];
}

/**
 * 判定推送紧急度（用于 header 配色与可选前缀）。
 *   - score ≥ 95 → urgent
 *   - 其余 → normal
 */
export function getPushUrgency(article: { score: number; aiStatus: string }): PushUrgency {
  if (article.score >= 95) return 'urgent';
  return 'normal';
}

/**
 * Build a Feishu interactive card message — compact layout:
 * - Header: article title with urgency-colored background
 * - Metadata + score tag (one tight row, no divider)
 * - 要点 / 洞察 merged into a single lark_md block (no section headers/dividers)
 * - Action: "查看原文" button
 */
export function buildFeishuCard(
  article: FeishuCardArticleInput,
  urgency: PushUrgency,
  options: FeishuCardOptions = {},
): Record<string, unknown> {
  const keyPoints = parseJsonArray(article.keyPoints);
  // tags 与 keyPoints 同样存为 JSON 字符串,这里做容错解析
  // 兼容旧格式(string[])和新格式(TagItem[{n,t}])
  const tags = parseTags(article.tags).map((t) => t.name);
  const brandLabel = splitBrands(article.brand).join(' | ');
  const relatedArticles = options.relatedArticles ?? [];

  // Header color —— 复用 getScoreStyle 的六色段位体系
  // urgent 优先；其余映射到飞书 template 色名：灰/黄/蓝/绿/紫/橙
  let headerTemplate: string;
  if (urgency === 'urgent') {
    headerTemplate = 'red';
  } else {
    headerTemplate = getScoreStyle(article.score).feishuColor;
  }

  // Format publish time (compact: MM-DD HH:mm)
  const timeStr = article.createdAt
    ? new Date(article.createdAt)
      .toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
      .replace(/\//g, '-')
    : '';

  // Build the single compact body block: 元信息行 + 要点 + 洞察
  // 全部塞进一个 lark_md,用换行和 emoji 分隔,避免多个 div/hr 撑高卡片。
  const lines: string[] = [];

  // 元信息行:时间 · 品牌 · 分类 · 中文来源名
  const metaParts = [
    timeStr,
    brandLabel ? `**${brandLabel}**` : '',
    article.category,
    article.originalSource || article.source?.name || '',
  ].filter(Boolean);
  if (metaParts.length > 0) {
    lines.push(`<font color='grey'>${metaParts.join(' · ')}</font>`);
  }

  // 要点:每条前缀「›」(单箭头,更锐利,符合情报场景的「读取-行动」语义)
  // tags 作为细分主题角标，紧跟在"要点"标题后(紫色 [xxx] 样式)
  if (keyPoints.length > 0 || tags.length > 0) {
    lines.push('');
    const tagPills = tags.length > 0
      ? `  <font color='violet'>[${tags.join('] [')}]</font>`
      : '';
    lines.push(`<font color='orange'>**📌 要点**</font>${tagPills}`);
    for (const p of keyPoints) {
      lines.push(`› ${p}`);
    }
  }

  // 洞察:直接跟在要点后,不加分隔线
  if (article.summary) {
    lines.push('');
    lines.push(`<font color='green'>**💡 洞察**</font>`);
    lines.push(article.summary);
  }

  // 近期关联动态：把单点信息升级为趋势感知，title 截 50 字 + 省略号控制卡片高度
  if (relatedArticles.length > 0) {
    const brandName = splitBrands(article.brand).join(' | ') || '相关品牌';
    lines.push('');
    lines.push(`<font color='blue'>**🔗 ${brandName}近期另有${relatedArticles.length}篇**</font>`);
    for (const r of relatedArticles) {
      const relatedDate = r.publishedAt ?? r.createdAt;
      const rTime = formatRelativeTime(relatedDate instanceof Date ? relatedDate.toISOString() : relatedDate);
      const rTitle = r.title.length > 50 ? r.title.slice(0, 50) + '…' : r.title;
      lines.push(`▪ <font color='grey'>${rTime}</font> ${rTitle}`);
    }
  }

  const elements: Record<string, unknown>[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: lines.join('\n'),
      },
    },
    // Action button 紧贴正文
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '查看原文' },
          type: 'primary',
          url: article.url,
        },
      ],
    },
  ];

  // 标题后缀：软文标记（isAd 仅在 aiStatus='done' 时置位）
  const headerSuffix = article.isAd ? ' [软文]' : '';

  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: {
          tag: 'plain_text',
          content: `${article.title}${headerSuffix}`,
        },
        template: headerTemplate,
      },
      elements,
    },
  };
}
