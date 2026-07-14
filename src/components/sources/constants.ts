export const DEFAULT_PARSER_CONFIGS: Record<string, string> = {
  html: JSON.stringify({ selector: 'article', titleSelector: 'h1', contentSelector: '.content', linkSelector: 'a', nextPageSelector: '' }, null, 2),
  rss: JSON.stringify({ feedUrl: '', fields: { title: 'title', link: 'link', description: 'description' } }, null, 2),
  websearch: JSON.stringify({ queries: [''], numPerQuery: 10, recencyDays: 3 }, null, 2),
  canyin88: JSON.stringify({}, null, 2),
}

export const CATEGORY_ICONS: Record<string, string> = {
  '餐饮': '🍜',
  '零售': '🛒',
  '食品': '🍿',
  '品牌': '⭐',
  '综合': '📰',
}

export const TYPE_LABELS: Record<string, string> = {
  'html': 'HTML',
  'rss': 'RSS',
  'canyin88': '餐饮88',
  'websearch': '网页搜索',
}
