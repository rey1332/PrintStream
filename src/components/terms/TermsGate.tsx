'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';

// Pages that work before the Terms & Conditions are accepted.
const EXEMPT = ['/login', '/erp/login', '/mfa', '/terms', '/reset-password'];

// Sends a signed-in account to /terms while the current version is not
// accepted. Only the way there: the database refuses all data until then
// (erp_check_request), whatever the browser does.
export function TermsGate() {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!user || EXEMPT.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return;
    let cancelled = false;
    fetch('/api/auth/terms-status', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled || body?.status?.required !== true) return;
        const here = pathname + window.location.search;
        router.replace(`/terms?next=${encodeURIComponent(here)}`);
      })
      .catch(() => {
        // Checked again on the next page; the database enforces it anyway.
      });
    return () => {
      cancelled = true;
    };
  }, [user, pathname, router]);

  return null;
}
