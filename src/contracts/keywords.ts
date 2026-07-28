/**
 * 关键词系统分组契约。
 *
 * 用户自定义分组必须从数据库读取；这里只保留跨前后端都需要理解的
 * 系统分组，避免服务端业务代码依赖浏览器端 features 目录。
 */
export const KEYWORD_DEFAULT_CATEGORY = 'default' as const
export const KEYWORD_BLACKLIST_CATEGORY = '黑名单' as const

export const SYSTEM_KEYWORD_CATEGORIES = [
  KEYWORD_BLACKLIST_CATEGORY,
  KEYWORD_DEFAULT_CATEGORY,
] as const

export type SystemKeywordCategory = (typeof SYSTEM_KEYWORD_CATEGORIES)[number]

export function isSystemKeywordCategory(value: string): value is SystemKeywordCategory {
  return (SYSTEM_KEYWORD_CATEGORIES as readonly string[]).includes(value)
}
