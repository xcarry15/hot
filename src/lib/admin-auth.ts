import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_SESSION_COOKIE = 'hot2_admin_session';
export const ADMIN_SESSION_MAX_AGE = 60 * 60 * 24 * 7;

const ADMIN_SESSION_CONTEXT = 'hot2-admin-session-v1';

/**
 * 会话签名密钥派生顺序：
 * 1. SESSION_SECRET（独立密钥，与 API_TOKEN 解耦；轮换 Token 不再使会话失效）
 * 2. API_TOKEN（兼容旧部署与未配置 SESSION_SECRET 的环境）
 *
 * 注意：这里只用于会话 Cookie 的 HMAC 签名，不参与 API Bearer 校验。
 * 单独引入 SESSION_SECRET 后，持 API_TOKEN 者不再能据此伪造会话 Cookie。
 */
function getSessionSecret(apiToken: string): string {
  const configured = process.env.SESSION_SECRET?.trim();
  return configured || apiToken;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sign(expiresAt: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${ADMIN_SESSION_CONTEXT}:${expiresAt}`)
    .digest('base64url');
}

/** Cookie 只保存派生会话值，不暴露可直接调用 API 的原始 Token。 */
export function createAdminSession(apiToken: string, now = Date.now()): string {
  const expiresAt = now + ADMIN_SESSION_MAX_AGE * 1000;
  return `${expiresAt}.${sign(expiresAt, getSessionSecret(apiToken))}`;
}

export function isValidAdminSession(
  session: string | undefined,
  apiToken: string,
  now = Date.now(),
): boolean {
  if (typeof session !== 'string') return false;
  const separator = session.indexOf('.');
  if (separator <= 0 || separator !== session.lastIndexOf('.')) return false;
  const expiresAtText = session.slice(0, separator);
  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const providedSignature = session.slice(separator + 1);

  // 严格解耦：仅用当前会话密钥校验。配置 SESSION_SECRET 后，API_TOKEN 签名一律无效，
  // 从根本上消除“持 API Token 者可伪造后台会话”。未配置时回退到 API_TOKEN，保持旧部署兼容。
  return safeEqual(providedSignature, sign(expiresAt, getSessionSecret(apiToken)));
}

export function isValidApiToken(candidate: string, expected: string): boolean {
  return safeEqual(candidate, expected);
}
