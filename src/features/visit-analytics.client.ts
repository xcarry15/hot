'use client';

const KEY = 'hot_visitor_id';
function visitorId(): string | null {
  try {
    const old = localStorage.getItem(KEY);
    if (old && /^[0-9a-f-]{36}$/i.test(old)) return old;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch { return null; }
}
export function sendVisit(kind: 'page' | 'tool', toolId?: string) {
  const id = visitorId();
  if (!id) return;
  let referrer = '';
  try { referrer = document.referrer ? new URL(document.referrer).origin : ''; } catch { referrer = ''; }
  void fetch('/api/public/visits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitorId: id, kind, toolId, referrer }), keepalive: true }).catch(() => {});
}
