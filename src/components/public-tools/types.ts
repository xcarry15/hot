import type {
  ToolDirectoryCategoryId,
  ToolDirectoryIconName,
  ToolDirectoryStatus,
  ToolDirectoryTag,
} from '@/contracts/tool-directory';

export type PublicToolIconName = ToolDirectoryIconName;
export type PublicToolStatus = ToolDirectoryStatus;
export type PublicToolTag = ToolDirectoryTag;

export interface PublicTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly href: string | null;
  readonly icon: PublicToolIconName;
  readonly status: PublicToolStatus;
  readonly tags: readonly PublicToolTag[];
}

export interface PublicToolCategory {
  readonly id: ToolDirectoryCategoryId;
  readonly label: string;
  readonly tools: readonly PublicTool[];
}
