const BASE = 'http://etna.invalid';

const unsafeChar = (c: string) => c === '\\' || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f;

export function safeNext(value: string | null | undefined, fallback = '/erp'): string {
  if (!value || !value.startsWith('/') || [...value].some(unsafeChar)) return fallback;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE || url.pathname.startsWith('/mfa')) return fallback;
  return url.pathname + url.search + url.hash;
}
