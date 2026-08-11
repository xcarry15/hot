// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchToolDirectory: vi.fn(),
  fetchToolDirectoryCategories: vi.fn(),
  updateToolDirectoryCategory: vi.fn(),
  moveToolDirectoryCategory: vi.fn(),
  createToolDirectoryCategory: vi.fn(),
  createToolDirectoryItem: vi.fn(),
  deleteToolDirectoryCategory: vi.fn(),
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
  createToolDirectoryCategory: mocks.createToolDirectoryCategory,
  createToolDirectoryItem: mocks.createToolDirectoryItem,
  deleteToolDirectoryCategory: mocks.deleteToolDirectoryCategory,
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
  { id: 'business-support' as const, name: '业务支持', sortOrder: 0, hidden: false },
  { id: 'geo-location' as const, name: '地理位置', sortOrder: 1, hidden: true },
  { id: 'data-analysis' as const, name: '数据分析', sortOrder: 2, hidden: false },
  { id: 'network-planning' as const, name: '点位分析', sortOrder: 3, hidden: false },
  { id: 'other-tools' as const, name: '其他工具', sortOrder: 4, hidden: false },
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

describe('分类维护弹窗', () => {
  let root: Root | null = null;

  beforeEach(() => {
    mocks.fetchToolDirectory.mockReset();
    mocks.fetchToolDirectoryCategories.mockReset();
    mocks.fetchToolDirectoryCategories.mockResolvedValue(categories);
    mocks.fetchToolDirectory.mockResolvedValue([tool]);
    mocks.createToolDirectoryCategory.mockReset();
    mocks.deleteToolDirectoryCategory.mockReset();
    mocks.updateToolDirectoryCategory.mockReset();
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    document.body.innerHTML = '';
  });

  async function renderManagement() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<ToolDirectoryManagement />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function findButton(text: string): HTMLButtonElement {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.includes(text));
    if (!button) throw new Error(`未找到包含「${text}」的按钮`);
    return button;
  }

  async function clickAndSettle(button: HTMLButtonElement) {
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('HTMLInputElement value setter 不存在');
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('新增分类表单提交会调用 createToolDirectoryCategory', async () => {
    await renderManagement();
    await clickAndSettle(findButton('分类维护'));
    await clickAndSettle(findButton('新增分类'));

    const idInput = document.querySelector<HTMLInputElement>('input[placeholder="如 store-opening"]');
    const nameInput = document.querySelector<HTMLInputElement>('input[placeholder="如 开店选址"]');
    expect(idInput).not.toBeNull();
    expect(nameInput).not.toBeNull();

    await act(async () => {
      setInputValue(idInput!, 'store-opening');
      setInputValue(nameInput!, '开店选址');
    });

    await clickAndSettle(findButton('创建分类'));

    expect(mocks.createToolDirectoryCategory).toHaveBeenCalledWith({ id: 'store-opening', name: '开店选址' });
    expect(mocks.toast.success).toHaveBeenCalledWith('分类已创建');
  });

  it('点击隐藏开关会调用 updateToolDirectoryCategory 更新 hidden', async () => {
    await renderManagement();
    await clickAndSettle(findButton('分类维护'));

    const switchEl = document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="数据分析 显示状态"]');
    expect(switchEl).not.toBeNull();
    expect(switchEl?.getAttribute('aria-checked')).toBe('true');

    await clickAndSettle(switchEl!);

    expect(mocks.updateToolDirectoryCategory).toHaveBeenCalledWith('data-analysis', { hidden: true });
    expect(mocks.toast.success).toHaveBeenCalledWith('分类已隐藏');
  });

  it('空分类可点删除并弹确认，确认后调用 deleteToolDirectoryCategory', async () => {
    await renderManagement();
    await clickAndSettle(findButton('分类维护'));

    // geo-location 为隐藏空分类，展示「已隐藏」角标
    expect(document.body.textContent).toContain('已隐藏');

    const geoInput = document.querySelector<HTMLInputElement>('input[aria-label="地理位置分类名称"]');
    expect(geoInput).not.toBeNull();
    const geoRow = geoInput!.parentElement;
    const geoDelete = geoRow?.querySelector<HTMLButtonElement>('button[title="删除分类"]');
    expect(geoDelete).not.toBeNull();
    expect(geoDelete!.disabled).toBe(false);

    await clickAndSettle(geoDelete!);
    expect(document.body.textContent).toContain('确认删除分类');

    await clickAndSettle(findButton('确认删除'));
    expect(mocks.deleteToolDirectoryCategory).toHaveBeenCalledWith('geo-location');
    expect(mocks.toast.success).toHaveBeenCalledWith('分类已删除');
  });

  it('非空分类的删除按钮禁用', async () => {
    await renderManagement();
    await clickAndSettle(findButton('分类维护'));

    const bizInput = document.querySelector<HTMLInputElement>('input[aria-label="业务支持分类名称"]');
    expect(bizInput).not.toBeNull();
    const bizRow = bizInput!.parentElement;
    const bizDelete = bizRow?.querySelector<HTMLButtonElement>('button[title="删除分类"]');
    expect(bizDelete).not.toBeNull();
    expect(bizDelete!.disabled).toBe(true);
  });
});
