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

const SYSTEM_EVIDENCE_BOUNDARY =
  '\n\n硬性证据边界：category 只按核心事件和主体归类；不得把推测、动机或道德判断写成事实；救灾、公益、事故和员工/消费者伤害等议题保持克制，没有正文证据时不使用欺诈、割韭菜、刷存在感、跑路等指控性表达。';

/**
 * 把自定义 system prompt 拼上 JSON 输出指令。
 * customSystem 为空字符串 / undefined → 用 DEFAULT_SYSTEM_PROMPT。
 * 始终在末尾追加不可覆盖的证据边界和 JSON_SUFFIX。
 */
export function buildSystemContent(customSystem?: string): string {
  const base = customSystem && customSystem.trim() ? customSystem : DEFAULT_SYSTEM_PROMPT;
  return base + SYSTEM_EVIDENCE_BOUNDARY + JSON_SUFFIX;
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

/**
 * 严格解析完整 JSON 对象。
 * 主分析链路已经要求只输出 JSON，因此不接受 Markdown 围栏、前后解释
 * 文字或 JSON 数组；格式不合规直接交给上层失败重试。
 */
export function parseStrictJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new Error('LLM 响应必须是完整 JSON 对象，不允许包含 Markdown 或其他文字');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `LLM 响应 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('LLM 响应必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
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

