/**
 * Preset Sources Configuration
 * 仅保留核心可用源，其他一律不在 UI 中展示。
 *
 * Source types:
 * - canyin88: 专用解析器，最稳定
 * - html: HTML 页面抓取，依赖站点结构
 * - websearch: 搜索引擎聚合，备用
 */

import type { SourceType } from './source-schema';

export interface PresetSource {
  id: string;
  name: string;
  type: SourceType;
  url: string;
  parserConfig: string; // JSON string with CSS selectors or RSS config
  category: string; // 餐饮/零售/品牌
  description: string;
}

export const PRESET_SOURCES: PresetSource[] = [
  // ========== 餐饮 ==========

  {
    id: 'canyin88',
    name: '餐饮88',
    type: 'canyin88',
    url: 'https://m.canyin88.com/zixun/',
    parserConfig: '{}',
    category: '餐饮',
    description: '餐饮行业资讯门户，涵盖餐饮动态、品牌创新、供应链等',
  },

  // ========== 零售 ==========

  {
    id: 'linkshop',
    name: '联商网',
    type: 'html',
    url: 'http://www.linkshop.com/news/pp/',
    parserConfig: JSON.stringify({
      listItem: 'div.box.clearfix',
      link: 'h2 a',
      title: 'h2 a',
      summary: 'p.text_overflow',
      date: '.time',
    }),
    category: '零售',
    description: '零售行业综合门户，品牌动态与行业资讯',
  },

  {
    id: 'winshang',
    name: '赢商网-项目页',
    type: 'html',
    url: 'https://news.winshang.com/list-11.html',
    parserConfig: JSON.stringify({
      listItem: '.winew-list li',
      link: 'h3 a',
      title: 'h3 a',
      summary: '.win-new-info',
      date: '.win-new-tab',
    }),
    category: '零售',
    description: '赢商网项目/购物中心资讯',
  },

  {
    id: 'winshang-brand',
    name: '赢商网-品牌页',
    type: 'html',
    url: 'https://news.winshang.com/list-12.html',
    parserConfig: JSON.stringify({
      listItem: '.winew-list li',
      link: 'h3 a',
      title: 'h3 a',
      summary: '.win-new-info',
      date: '.win-new-tab',
    }),
    category: '品牌',
    description: '赢商网品牌动态与行业资讯',
  },

  {
    id: 'winshang-data',
    name: '赢商网-数据页',
    type: 'html',
    url: 'https://news.winshang.com/list-70.html',
    parserConfig: JSON.stringify({
      listItem: '.winew-list li',
      link: 'h3 a',
      title: 'h3 a',
      summary: '.win-new-info',
      date: '.win-new-tab',
    }),
    category: '零售',
    description: '赢商网商业数据与行业报告',
  },
];

/**
 * Get preset source by ID
 */
export function getPresetSourceById(id: string): PresetSource | undefined {
  return PRESET_SOURCES.find(s => s.id === id);
}

/**
 * Get all available categories
 */
export function getPresetCategories(): string[] {
  const cats = new Set(PRESET_SOURCES.map(s => s.category));
  return Array.from(cats);
}
