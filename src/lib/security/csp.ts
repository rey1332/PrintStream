// The Content Security Policy of every page, set per request by src/middleware.ts.
//
// Scripts run only with this request's nonce (Next.js puts it on its own
// scripts when it finds it in the request's CSP header; the root layout puts
// it on the two boot scripts and next-themes'). 'strict-dynamic' lets those
// scripts load the app's chunks. No 'unsafe-inline' for scripts: injected
// markup cannot run code. Styles keep 'unsafe-inline' (React style attributes).

export interface ImageHost {
  protocol: string;
  hostname: string;
}

/** 16 random bytes, base64: a new one for every request. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function contentSecurityPolicy(
  nonce: string,
  { dev = false, imageHosts = [] }: { dev?: boolean; imageHosts?: ImageHost[] } = {}
): string {
  return [
    "default-src 'self'",
    // Development: React's error overlay and fast refresh need eval.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${imageHosts.map((h) => ` ${h.protocol}://${h.hostname}`).join('')}`,
    "font-src 'self' data:",
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}
