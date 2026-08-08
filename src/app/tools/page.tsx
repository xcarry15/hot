import type { Metadata } from 'next';
import PublicToolsPage from '@/components/public-tools/public-tools-page';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: '工具中心 | 行业新闻聚合',
  description: '选址、地理位置、数据分析与文件工具入口。',
};

export default function ToolsRoute() {
  return <PublicToolsPage />;
}
