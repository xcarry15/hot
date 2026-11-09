'use client';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { sendVisit } from '@/features/visit-analytics.client';
export default function PublicVisitTracker() {
  const path = usePathname();
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (last.current === path) return;
    last.current = path;
    sendVisit('page');
  }, [path]);
  return null;
}
