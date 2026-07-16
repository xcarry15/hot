import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_SESSION_COOKIE = 'hot2_admin_session';
export const ADMIN_SESSION_MAX_AGE = 60 * 60 * 24 * 7;

const ADMIN_SESSION_CONTEXT = 'hot2-admin-session-v1';

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** Cookie 只保存派生会话值，不暴露可直接调用 API 的原始 Token。 */
export function createAdminSession(apiToken: string, now = Date.now()): string {
  const expiresAt = now + ADMIN_SESSION_MAX_AGE * 1000;
  const signature = createHmac('sha256', apiToken)
    .update(`${ADMIN_SESSION_CONTEXT}:${expiresAt}`)
    .digest('base64url');
  return `${expiresAt}.${signature}`;
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
  const expectedSignature = createHmac('sha256', apiToken)
    .update(`${ADMIN_SESSION_CONTEXT}:${expiresAt}`)
    .digest('base64url');
  return safeEqual(session.slice(separator + 1), expectedSignature);
}

export function isValidApiToken(candidate: string, expected: string): boolean {
  return safeEqual(candidate, expected);
}
