// Calls to /api/admin/platform/*. Errors come back as codes (see
// src/server/admin/service.ts); the pages turn them into messages.

export type AdminResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(url: string, init?: RequestInit): Promise<AdminResult<T>> {
  try {
    const response = await fetch(url, { cache: 'no-store', ...init });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.success)
      return { ok: false, error: typeof result?.error === 'string' ? result.error : 'failed' };
    return { ok: true, data: result.data as T };
  } catch {
    return { ok: false, error: 'failed' };
  }
}

export const adminGet = <T>(url: string) => call<T>(url);

export const adminPost = <T = undefined>(url: string, body: unknown) =>
  call<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * A change that may need a two-factor code from the last 10 minutes: when the
 * server asks for one, ask the admin once and try once more. A cancelled
 * prompt comes back as the error 'cancelled'.
 */
export async function adminChange<T = undefined>(
  confirmIdentity: () => Promise<boolean>,
  url: string,
  body: unknown
): Promise<AdminResult<T>> {
  const first = await adminPost<T>(url, body);
  if (first.ok || first.error !== 'reauth_required') return first;
  if (!(await confirmIdentity())) return { ok: false, error: 'cancelled' };
  return adminPost<T>(url, body);
}

/**
 * Downloads a CSV export (POST /api/admin/platform/export), asking for a
 * two-factor code when the server wants one.
 */
export async function adminExport(
  confirmIdentity: () => Promise<boolean>,
  body: Record<string, unknown>
): Promise<AdminResult<undefined>> {
  const request = () =>
    fetch('/api/admin/platform/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    let response = await request();
    if (!response.ok) {
      const error = (await response.json().catch(() => null))?.error;
      if (error !== 'reauth_required') return { ok: false, error: error ?? 'failed' };
      if (!(await confirmIdentity())) return { ok: false, error: 'cancelled' };
      response = await request();
      if (!response.ok)
        return { ok: false, error: (await response.json().catch(() => null))?.error ?? 'failed' };
    }
    const name =
      /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ??
      'etna-export.csv';
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { ok: true, data: undefined };
  } catch {
    return { ok: false, error: 'failed' };
  }
}
