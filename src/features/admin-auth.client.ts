import { clearApiToken } from '@/lib/api-client';

export async function logoutAdminSession(): Promise<void> {
  try {
    await fetch('/api/admin-auth', { method: 'DELETE', credentials: 'same-origin' });
  } finally {
    // Remove the legacy localStorage token from browsers upgraded from the
    // previous client-side gate.
    clearApiToken();
  }
}
