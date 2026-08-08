import { PUBLIC_TOOL_CATEGORIES } from '../components/public-tools/tool-catalog';
import type { ToolDirectorySeedItem, ToolDirectoryStatus, ToolDirectoryTag } from '@/contracts/tool-directory';

function normalizeLegacyStatus(status: 'hot' | 'new' | 'beta' | 'disabled' | undefined): {
  status: ToolDirectoryStatus;
  tags: ToolDirectoryTag[];
} {
  if (status === 'beta') return { status: 'beta', tags: [] };
  if (status === 'disabled') return { status: 'disabled', tags: [] };
  if (status === 'hot') return { status: 'active', tags: ['popular'] };
  if (status === 'new') return { status: 'active', tags: ['new'] };
  return { status: 'active', tags: [] };
}

export const TOOL_DIRECTORY_SEED: ToolDirectorySeedItem[] = PUBLIC_TOOL_CATEGORIES.flatMap((category) => (
  category.tools.map((tool, sortOrder) => {
    const normalized = normalizeLegacyStatus('status' in tool ? tool.status : undefined);
    return {
      id: tool.id,
      name: tool.name,
      description: tool.description,
      category: category.id as ToolDirectorySeedItem['category'],
      href: tool.href,
      icon: tool.icon,
      kind: tool.kind,
      status: normalized.status,
      tags: normalized.tags,
      sortOrder,
    };
  })
));
