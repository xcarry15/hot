import { PUBLIC_TOOL_CATEGORIES } from '../components/public-tools/tool-catalog';
import type { ToolDirectorySeedItem } from '@/contracts/tool-directory';

export const TOOL_DIRECTORY_SEED: ToolDirectorySeedItem[] = PUBLIC_TOOL_CATEGORIES.flatMap((category) => (
  category.tools.map((tool, sortOrder) => ({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    category: category.id as ToolDirectorySeedItem['category'],
    href: tool.href,
    icon: tool.icon,
    status: 'status' in tool ? tool.status : 'active',
    tags: 'tags' in tool ? [...tool.tags] : [],
    sortOrder,
  }))
));
