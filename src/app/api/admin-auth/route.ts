import { NextResponse } from 'next/server';
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE,
  createAdminSession,
  isValidApiToken,
} from '@/lib/admin-auth';
import { enforceAdminAuthRateLimit } from '@/lib/admin-auth-rate-limit';

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    // The proxy also uses this cookie to inject Authorization on /api/*.
    // It therefore must be sent to the API path as well as /admin.
    path: '/',
    maxAge: ADMIN_SESSION_MAX_AGE,
  };
}

export async function POST(request: Request) {
  const limited = enforceAdminAuthRateLimit(request);
  if (limited) return limited;

  const expected = process.env.API_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: 'API_TOKEN 未配置' }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '无效的请求格式' }, { status: 400 });
  }
  const token = body && typeof body === 'object' && 'token' in body
    ? (body as { token?: unknown }).token
    : undefined;
  if (typeof token !== 'string' || !isValidApiToken(token, expected)) {
    return NextResponse.json({ error: 'API Token 无效' }, { status: 401 });
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set(ADMIN_SESSION_COOKIE, createAdminSession(expected), cookieOptions());
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  response.cookies.set(ADMIN_SESSION_COOKIE, '', { ...cookieOptions(), maxAge: 0 });
  return response;
}
