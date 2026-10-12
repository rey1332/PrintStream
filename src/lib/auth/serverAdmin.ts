// Whether the signed-in person is one of the server's administrators
// (ETNA_ADMIN_EMAILS). The session says so only to them; for everyone else
// the admin tools are not mentioned and their addresses answer "not found".

let cached: Promise<boolean> | null = null;

export function isServerAdmin(): Promise<boolean> {
  cached ??= fetch('/api/auth/session', { cache: 'no-store' })
    .then((r) => r.json())
    .then((s) => s?.serverAdmin === true)
    .catch(() => false);
  // Asked again next time when it failed or said no (signing in changes it).
  cached.then((yes) => {
    if (!yes) cached = null;
  });
  return cached;
}
