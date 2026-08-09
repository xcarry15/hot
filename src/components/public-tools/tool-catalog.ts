import type { PublicToolIconName } from './types';
import type { ToolDirectoryStatus, ToolDirectoryTag } from '@/contracts/tool-directory';

interface StaticTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly href: string | null;
  readonly icon: PublicToolIconName;
  readonly status?: ToolDirectoryStatus;
  readonly tags?: readonly ToolDirectoryTag[];
}

interface StaticToolCategory {
  readonly id: string;
  readonly label: string;
  readonly tools: readonly StaticTool[];
}

/**
 * One-time seed snapshot of the tstwg.cn tool directory.
 *
 * Runtime pages read the database. This file remains only as the source for
 * the first database initialization and must not be used as a public fallback.
 */
export const PUBLIC_TOOL_CATEGORIES = [
  {
    id: 'business-support',
    label: '业务支持',
    tools: [
      {
        id: 'bs-1',
        name: '新店测算',
        description: '快速评估新店选址的各项利润指标，有效评估点位商业价值。',
        href: null,
        icon: 'store',
        status: 'disabled',
      },
      {
        id: 'bs-4',
        name: '点位分析',
        description: '适用任意点位的业态评估工具，让选址决策更快更准。',
        href: 'https://lat2.tstwg.cn',
        icon: 'map-pin',
        tags: ['popular'],
      },
      {
        id: 'bs-5',
        name: '乡镇查询',
        description: '便捷查询乡镇数据，具备可视化图表和AI分析推荐功能。',
        href: 'https://xz.tstwg.cn',
        icon: 'sprout',
      },
      {
        id: 'bs-2',
        name: '友商业绩',
        description: '精准测算对标友商门店实际业绩表现！',
        href: 'https://ls.tstwg.cn',
        icon: 'bar-chart',
      },
      {
        id: 'bs-6',
        name: '盈利分析',
        description: '将时间序列转化为热力图的可视化分析工具。',
        href: 'https://vda.tstwg.cn',
        icon: 'chart-area',
      },
      {
        id: 'bs-7',
        name: 'BI数据',
        description: '快速处理BI数据，聚合门店信息，计算盈利趋势。',
        href: 'https://bi-data.streamlit.app/#bi',
        icon: 'database',
      },
      {
        id: 'bs-8',
        name: 'H3六边形可视化',
        description: '即将上线',
        href: 'https://6.tstwg.cn/',
        icon: 'hexagon',
        status: 'coming_soon',
      },
    ],
  },
  {
    id: 'geo-location',
    label: '地理位置',
    tools: [
      {
        id: 'gl-1',
        name: 'POI搜索',
        description: '轻松、高效的获取全国范围内任意品牌的POI点位数据。',
        href: 'https://poi.tstwg.cn/',
        icon: 'map',
        tags: ['popular'],
      },
      {
        id: 'gl-2',
        name: 'POI清洗',
        description: '一键清理高德POI中的重复和无效点位。',
        href: 'https://gdqx.tstwg.cn/',
        icon: 'trash',
      },
      {
        id: 'gl-3',
        name: '经纬度计算',
        description: '计算多个点位之间的经纬度距离，支持批量处理。',
        href: 'https://lat.tstwg.cn/',
        icon: 'ruler',
      },
      {
        id: 'gl-4',
        name: '经纬度解析',
        description: '通过经纬度，逆向解析出对应的行政区划地理位置',
        href: 'https://lat4.tstwg.cn/',
        icon: 'zap',
      },
      {
        id: 'gl-5',
        name: '地图可视化',
        description: '高性能地图可视化纠偏工具，支持热力图、行政区划等功能。',
        href: 'https://map.tstwg.cn',
        icon: 'globe-2',
        tags: ['latest'],
      },
      {
        id: 'gl-6',
        name: '坐标系转换',
        description: '多坐标系转换工具，支持WGS84, GCJ02, BD09等常见坐标系。',
        href: 'https://lat3.tstwg.cn',
        icon: 'globe',
      },
    ],
  },
  {
    id: 'data-analysis',
    label: '数据分析',
    tools: [
      {
        id: 'da-2',
        name: '回归分析',
        description: '在线回归分析工具，支持多种回归模型和数据可视化。',
        href: 'https://re.tstwg.cn',
        icon: 'line-chart',
      },
      {
        id: 'da-3',
        name: '计划拆分工具',
        description: '将任何月度计划进一步拆分为周计划，并提供可视化结果。',
        href: 'https://week.tstwg.cn/',
        icon: 'target',
      },
    ],
  },
  {
    id: 'network-planning',
    label: '点位分析',
    tools: [
      {
        id: 'np-1',
        name: '城市聚客点',
        description: '基于密度的聚类（DBSCAN）算法工具，识别有效聚客点。',
        href: 'https://dbscan.tstwg.cn',
        icon: 'users',
      },
      {
        id: 'np-2',
        name: '竞品可视化',
        description: '竞品数据可视化分析工具，用于高价值商圈点位分析。',
        href: 'https://vs.tstwg.cn/',
        icon: 'pie-chart',
      },
    ],
  },
  {
    id: 'other-tools',
    label: '其他工具',
    tools: [
      {
        id: 'da-4',
        name: 'Excel-字段提取',
        description: '从 Excel 表中按列名快速提取所需字段，适合用于清洗与字段重组。',
        href: 'https://xlsx.tstwg.cn/',
        icon: 'file-spreadsheet',
      },
      {
        id: 'da-5',
        name: 'Excel-文件合并',
        description: '【EXE格式】一个用于批量合并 Excel 文件的小工具。',
        href: 'https://4275.com/ten4yu',
        icon: 'files',
      },
    ],
  },
] as const satisfies readonly StaticToolCategory[];
