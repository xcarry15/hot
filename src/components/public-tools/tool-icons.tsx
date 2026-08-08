import {
  BarChart3,
  ChartArea,
  Database,
  FileSpreadsheet,
  Files,
  Globe,
  Globe2,
  Hexagon,
  LineChart,
  Map,
  MapPin,
  PieChart,
  Ruler,
  Sprout,
  Store,
  Target,
  Trash2,
  Users,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PublicToolIconName } from './types';

const TOOL_ICONS: Record<PublicToolIconName, LucideIcon> = {
  store: Store,
  'map-pin': MapPin,
  sprout: Sprout,
  'bar-chart': BarChart3,
  'chart-area': ChartArea,
  database: Database,
  hexagon: Hexagon,
  map: Map,
  trash: Trash2,
  ruler: Ruler,
  zap: Zap,
  'globe-2': Globe2,
  globe: Globe,
  'line-chart': LineChart,
  target: Target,
  users: Users,
  'pie-chart': PieChart,
  'file-spreadsheet': FileSpreadsheet,
  files: Files,
};

export default function PublicToolIcon({
  name,
}: {
  name: PublicToolIconName;
}) {
  const Icon = TOOL_ICONS[name]
  return <Icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.7} />;
}
