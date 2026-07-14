/**
 * 前端 API Token 工具
 *
 * 统一管理 localStorage 中的 `api_token` 读写。客户端请求 helper 在请求边界
 * 显式读取它并注入 Authorization，避免篡改全局 fetch。
 *
 * 历史：此文件早期还导出过 `apiFetch()` helper；请求统一由
 * `request-json.client.ts` 处理。
 */

const TOKEN_STORAGE_KEY = 'api_token';

export function getApiToken(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(TOKEN_STORAGE_KEY) || '';
}

export function setApiToken(token: string): void {
  if (typeof window === 'undefined') return;
  if (token) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

export function clearApiToken(): void {
  setApiToken('');
}
