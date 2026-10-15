'use client';

// A session opened with "This is a shared computer" (a weighbridge or office
// PC) ends after a few minutes without activity: the server refuses it then
// (src/server/auth/service.ts, SHARED_IDLE_MS), and this page signs out and
// returns to the sign-in page, so the next person does not find it open.

import { useEffect, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';

const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function SharedComputerGuard() {
  const { user, signOut } = useAuth();
  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;
  const userId: string | undefined = user?.id;

  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleMs = 0;

    const end = async () => {
      if (stopped) return;
      stopped = true;
      try {
        await signOutRef.current();
      } finally {
        window.location.assign(
          window.location.pathname.startsWith('/erp') ? '/erp/login' : '/login'
        );
      }
    };
    // Someone working on one page (typing, no saves) is active: tell the server
    // now and then, so its idle limit follows the person, not the requests.
    let lastPing = Date.now();
    const restart = () => {
      if (stopped || !idleMs) return;
      clearTimeout(timer);
      timer = setTimeout(end, idleMs);
      if (Date.now() - lastPing > Math.min(120_000, idleMs / 4)) {
        lastPing = Date.now();
        void fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }).catch(() => {});
      }
    };

    void fetch('/api/auth/session', { cache: 'no-store' })
      .then((r) => r.json())
      .then((s) => {
        const seconds = Number(s?.shared?.idleSeconds);
        if (stopped || !Number.isFinite(seconds) || seconds <= 0) return;
        idleMs = seconds * 1000;
        for (const event of ACTIVITY) window.addEventListener(event, restart, { passive: true });
        restart();
      })
      .catch(() => {});

    return () => {
      stopped = true;
      clearTimeout(timer);
      for (const event of ACTIVITY) window.removeEventListener(event, restart);
    };
  }, [userId]);

  return null;
}
