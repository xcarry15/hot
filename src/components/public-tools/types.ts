export type PublicToolIconName =
  | 'store'
  | 'map-pin'
  | 'sprout'
  | 'bar-chart'
  | 'chart-area'
  | 'database'
  | 'hexagon'
  | 'map'
  | 'trash'
  | 'ruler'
  | 'zap'
  | 'globe-2'
  | 'globe'
  | 'line-chart'
  | 'target'
  | 'users'
  | 'pie-chart'
  | 'file-spreadsheet'
  | 'files';

export type PublicToolStatus = 'hot' | 'new' | 'beta' | 'disabled';

export type PublicToolKind = 'open' | 'download';

export interface PublicTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly href: string | null;
  readonly icon: PublicToolIconName;
  readonly kind: PublicToolKind;
  readonly status?: PublicToolStatus;
}

export interface PublicToolCategory {
  readonly id: string;
  readonly label: string;
  readonly tools: readonly PublicTool[];
}
