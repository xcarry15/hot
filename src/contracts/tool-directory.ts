/** 工具中心初始化分类；运行时名称与排序由数据库维护。 */
export const TOOL_CATEGORY_SEED_DEFINITIONS = [
  { id: 'business-support', label: '业务支持' },
  { id: 'geo-location', label: '地理位置' },
  { id: 'data-analysis', label: '数据分析' },
  { id: 'network-planning', label: '点位分析' },
  { id: 'other-tools', label: '其他工具' },
] as const;

export type ToolDirectoryCategoryId = (typeof TOOL_CATEGORY_SEED_DEFINITIONS)[number]['id'];

export interface ToolDirectoryCategoryDto {
  id: ToolDirectoryCategoryId;
  name: string;
  sortOrder: number;
}

export const TOOL_DIRECTORY_TAG_DEFINITIONS = [
  { id: 'free', label: '免费' },
  { id: 'paid', label: '付费' },
  { id: 'popular', label: '热门' },
  { id: 'updated', label: '有更新' },
  { id: 'latest', label: '最新' },
] as const;

export type ToolDirectoryTag = (typeof TOOL_DIRECTORY_TAG_DEFINITIONS)[number]['id'];

export const TOOL_DIRECTORY_STATUSES = [
  'active',
  'beta',
  'maintenance',
  'coming_soon',
  'disabled',
] as const;
export type ToolDirectoryStatus = (typeof TOOL_DIRECTORY_STATUSES)[number];

export const TOOL_DIRECTORY_LINKABLE_STATUSES = ['active', 'beta'] as const satisfies readonly ToolDirectoryStatus[];

export function isToolDirectoryLinkableStatus(status: ToolDirectoryStatus): boolean {
  return TOOL_DIRECTORY_LINKABLE_STATUSES.includes(status as (typeof TOOL_DIRECTORY_LINKABLE_STATUSES)[number]);
}

export const TOOL_DIRECTORY_ICON_NAMES = [
  'store',
  'map-pin',
  'sprout',
  'bar-chart',
  'chart-area',
  'database',
  'hexagon',
  'map',
  'trash',
  'ruler',
  'zap',
  'globe-2',
  'globe',
  'line-chart',
  'target',
  'users',
  'pie-chart',
  'file-spreadsheet',
  'files',
  'calculator',
  'search',
  'upload',
  'download',
  'file-text',
  'table-2',
  'layers-3',
  'building-2',
  'briefcase-business',
  'shopping-bag',
  'scan-search',
  'route',
  'navigation',
  'map-pinned',
  'chart-no-axes-combined',
  'chart-column',
  'folder-cog',
  'wrench',
  'bot',
  'sparkles',
  'folder',
  'folder-open',
  'folder-kanban',
  'folder-git-2',
  'workflow',
  'kanban',
  'clipboard-list',
  'clipboard-check',
  'list-checks',
  'goal',
  'milestone',
  'boxes',
  'package',
  'package-open',
  'database-zap',
  'database-backup',
  'server',
  'hard-drive',
  'table-properties',
  'rows-3',
  'columns-3',
  'file-chart-column',
  'file-chart-line',
  'chart-spline',
  'chart-bar',
  'chart-line',
  'chart-pie',
  'chart-scatter',
  'sigma',
  'binary',
  'braces',
  'code-2',
  'locate-fixed',
  'locate',
  'crosshair',
  'pin',
  'map-pin-house',
  'landmark',
  'warehouse',
  'signpost',
  'compass',
  'waypoints',
  'handshake',
  'shopping-cart',
  'receipt-text',
  'badge-dollar-sign',
  'circle-dollar-sign',
  'wallet-cards',
  'banknote',
  'presentation',
  'factory',
  'users-round',
  'contact-round',
] as const;

export type ToolDirectoryIconName = (typeof TOOL_DIRECTORY_ICON_NAMES)[number];

export interface ToolDirectoryItemDto {
  id: string;
  name: string;
  description: string;
  category: ToolDirectoryCategoryId;
  href: string | null;
  icon: ToolDirectoryIconName;
  status: ToolDirectoryStatus;
  tags: ToolDirectoryTag[];
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolDirectorySeedItem {
  id: string;
  name: string;
  description: string;
  category: ToolDirectoryCategoryId;
  href: string | null;
  icon: ToolDirectoryIconName;
  status: ToolDirectoryStatus;
  tags: ToolDirectoryTag[];
  sortOrder: number;
}

export interface ToolDirectoryBackupPayload {
  type: 'hot2-tool-directory-backup';
  version: 1;
  exportedAt: string;
  categories: ToolDirectoryCategoryDto[];
  tools: Array<Pick<
    ToolDirectoryItemDto,
    'id' | 'name' | 'description' | 'category' | 'href' | 'icon' | 'status' | 'tags' | 'sortOrder' | 'archivedAt'
  >>;
}
