/**
 * AI 处理公共工具函数 —— 前后端共享
 *
 * 用于单步 AI 分析流程，提供:
 *   - system prompt + JSON_SUFFIX 拼接
 *   - LLM 响应中 JSON 提取与解析
 *   - 数值字段 clamp 裁剪
 *
 * 注意:此文件可被 client 引用(占位符校验),禁止引入 server-only 依赖。
 */

import {
  DEFAULT_SYSTEM_PROMPT,
  JSON_SUFFIX,
} from './prompts';

/**
 * 把自定义 system prompt 拼上 JSON 输出指令。
 * customSystem 为空字符串 / undefined → 用 DEFAULT_SYSTEM_PROMPT。
 * 始终在末尾追加 JSON_SUFFIX。
 */
export function buildSystemContent(customSystem?: string): string {
  const base = customSystem && customSystem.trim() ? customSystem : DEFAULT_SYSTEM_PROMPT;
  return base + JSON_SUFFIX;
}

/**
 * 从 LLM 响应文本中提取首个 JSON 对象并解析。
 * 失败时抛标准化 Error(含原始片段),让调用方统一 catch。
 *
 * 策略：
 * 1. 直接解析完整文本；
 * 2. 尝试提取 ```json ... ``` / ``` ... ``` 围栏；
 * 3. 用平衡括号算法取最外层 {...}，避免贪婪匹配跨代码块抓取。
 */
export function extractJsonObject(text: string): Record<string, unknown> {
  const candidate = extractFirstJson(text);
  if (!candidate) {
    throw new Error(
      `LLM 响应中未找到 JSON 片段,原文前 200 字: ${text.substring(0, 200)}`,
    );
  }
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `LLM 响应 JSON 解析失败: ${err instanceof Error ? err.message : String(err)};片段前 200 字: ${candidate.substring(0, 200)}`,
    );
  }
}

/** 尝试多种方式提取 JSON 文本片段，失败返回空串 */
function extractFirstJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  // 1. 直接解析完整文本
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // 继续后续提取
  }

  // 2. 提取 markdown 代码块（优先 json 标签）
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    try {
      JSON.parse(inner);
      return inner;
    } catch {
      // 围栏内可能还有额外说明，继续取最外层 {}
    }
  }

  // 3. 平衡括号：取第一个 '{' 开始、括号匹配的最外层对象
  let depth = 0;
  let start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          return trimmed.slice(start, i + 1);
        }
      }
    }
  }

  return '';
}

/**
 * 取字符串数组字段,裁剪到 maxItems 条,过滤非字符串。
 */
export function pickStringArray(v: unknown, maxItems: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .slice(0, maxItems);
}

/** 带情感色调的标签对象 */
export interface TagItem {
  n: string // 标签名
  t: string // 色调: 正/负/中/警/机
}

/**
 * 取标签对象数组字段,裁剪到 maxItems 条。
 * 兼容旧格式(纯字符串数组) → 降级为 t:"中"。
 */
export function pickTagArray(v: unknown, maxItems: number): TagItem[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, maxItems).map(item => {
    if (typeof item === 'string') {
      return { n: item, t: '中' };
    }
    if (typeof item === 'object' && item !== null) {
      const obj = item as Record<string, unknown>;
      const name = typeof obj.n === 'string' ? obj.n.trim() : '';
      const tone = typeof obj.t === 'string' && ['正','负','中','警','机'].includes(obj.t) ? obj.t : '中';
      return { n: name, t: tone };
    }
    return { n: String(item), t: '中' };
  }).filter(x => x.n.length > 0);
}
