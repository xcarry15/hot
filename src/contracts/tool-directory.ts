export const TOOL_CATEGORY_DEFINITIONS = [
  { id: 'business-support', label: '业务支持' },
  { id: 'geo-location', label: '地理位置' },
  { id: 'data-analysis', label: '数据分析' },
  { id: 'network-planning', label: '点位分析' },
  { id: 'other-tools', label: '其他工具' },
] as const;

export type ToolDirectoryCategoryId = (typeof TOOL_CATEGORY_DEFINITIONS)[number]['id'];

export const TOOL_DIRECTORY_TAG_DEFINITIONS = [
  { id: 'popular', label: '热门' },
  { id: 'new', label: '新品' },
  { id: 'recommended', label: '推荐' },
  { id: 'free', label: '免费' },
  { id: 'download', label: '下载' },
] as const;

export type ToolDirectoryTag = (typeof TOOL_DIRECTORY_TAG_DEFINITIONS)[number]['id'];

export const TOOL_DIRECTORY_STATUSES = ['active', 'beta', 'disabled'] as const;
export type ToolDirectoryStatus = (typeof TOOL_DIRECTORY_STATUSES)[number];

export const TOOL_DIRECTORY_KINDS = ['open', 'download'] as const;
export type ToolDirectoryKind = (typeof TOOL_DIRECTORY_KINDS)[number];

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
] as const;

export type ToolDirectoryIconName = (typeof TOOL_DIRECTORY_ICON_NAMES)[number];

export interface ToolDirectoryItemDto {
  id: string;
  name: string;
  description: string;
  category: ToolDirectoryCategoryId;
  href: string | null;
  icon: ToolDirectoryIconName;
  kind: ToolDirectoryKind;
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
  kind: ToolDirectoryKind;
  status: ToolDirectoryStatus;
  tags: ToolDirectoryTag[];
  sortOrder: number;
}
