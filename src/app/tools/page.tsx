import type { Metadata } from 'next';
import PublicToolsPage from '@/components/public-tools/public-tools-page';
import { getPublicToolCategories } from '@/lib/tool-directory-service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '工具中心 | 行业新闻聚合',
  description: '选址、地理位置、数据分析与文件工具入口。',
};

export default async function ToolsRoute() {
  let categories;
  let hasError = false;
  try {
    categories = await getPublicToolCategories();
  } catch (caughtError) {
    console.error('[tools] failed to load tool directory:', caughtError);
    hasError = true;
  }
  return <PublicToolsPage categories={categories ?? []} error={hasError} />;
}
