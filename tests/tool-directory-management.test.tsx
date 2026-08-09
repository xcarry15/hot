// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchToolDirectory: vi.fn(),
  fetchToolDirectoryCategories: vi.fn(),
  updateToolDirectoryCategory: vi.fn(),
  moveToolDirectoryCategory: vi.fn(),
  createToolDirectoryItem: vi.fn(),
  updateToolDirectoryItem: vi.fn(),
  archiveToolDirectoryItem: vi.fn(),
  restoreToolDirectoryItem: vi.fn(),
  moveToolDirectoryItem: vi.fn(),
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/features/tool-directory-api.client', () => ({
  fetchToolDirectory: mocks.fetchToolDirectory,
  fetchToolDirectoryCategories: mocks.fetchToolDirectoryCategories,
  updateToolDirectoryCategory: mocks.updateToolDirectoryCategory,
  moveToolDirectoryCategory: mocks.moveToolDirectoryCategory,
  createToolDirectoryItem: mocks.createToolDirectoryItem,
  updateToolDirectoryItem: mocks.updateToolDirectoryItem,
  archiveToolDirectoryItem: mocks.archiveToolDirectoryItem,
  restoreToolDirectoryItem: mocks.restoreToolDirectoryItem,
  moveToolDirectoryItem: mocks.moveToolDirectoryItem,
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));

import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ToolDirectoryManagement from '@/components/settings/tool-directory';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const tool = {
  id: 'tool-1',
  name: '测试工具',
  description: '用于验证首次进入工具中心时的读取流程。',
  category: 'business-support' as const,
  href: 'https://example.com',
  icon: 'store' as const,
  status: 'active' as const,
  tags: [],
  sortOrder: 0,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const categories = [
  { id: 'business-support' as const, name: '业务支持', sortOrder: 0 },
  { id: 'geo-location' as const, name: '地理位置', sortOrder: 1 },
  { id: 'data-analysis' as const, name: '数据分析', sortOrder: 2 },
  { id: 'network-planning' as const, name: '点位分析', sortOrder: 3 },
  { id: 'other-tools' as const, name: '其他工具', sortOrder: 4 },
];

function requestAbortedError(): Error & { status: number } {
  const error = new Error('请求已取消') as Error & { status: number };
  error.name = 'RequestJsonError';
  error.status = 499;
  return error;
}

describe('工具目录首次加载', () => {
  let root: Root | null = null;

  beforeEach(() => {
    mocks.fetchToolDirectory.mockReset();
    mocks.fetchToolDirectoryCategories.mockReset();
    mocks.fetchToolDirectoryCategories.mockResolvedValue(categories);
    mocks.fetchToolDirectory.mockImplementation((_includeArchived: boolean, signal?: AbortSignal) => {
      if (mocks.fetchToolDirectory.mock.calls.length === 1) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(requestAbortedError()), { once: true });
        });
      }
      return Promise.resolve([tool]);
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    document.body.innerHTML = '';
  });

  it('忽略 StrictMode 首次挂载产生的 499 取消，不显示读取失败', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <StrictMode>
          <ToolDirectoryManagement />
        </StrictMode>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.fetchToolDirectory).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('测试工具');
    expect(container.textContent).not.toContain('工具目录读取失败');
    expect(mocks.toast.error).not.toHaveBeenCalledWith('获取工具目录失败');
  });
});
