'use client';

// An invitation e-mail links to /erp#join=<code>. The code stays after "#"
// (never sent to the server or written to proxy logs); it is moved into this
// tab's session storage and removed from the address bar, and the workspace
// panel offers it in its Join form.

const KEY = 'etna.pendingJoin';

/** Takes a join code from the address bar, if any. Returns whether one is pending. */
export function capturePendingJoin(): boolean {
  if (typeof window === 'undefined') return false;
  const match = window.location.hash.match(/(?:^#|&)join=([^&]+)/);
  if (match) {
    try {
      sessionStorage.setItem(KEY, decodeURIComponent(match[1]).slice(0, 64));
    } catch {
      // Storage blocked: the code is simply not pre-filled.
    }
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return pendingJoin() !== null;
}

export function pendingJoin(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearPendingJoin() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
