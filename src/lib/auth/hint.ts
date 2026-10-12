export const SESSION_COOKIE = 'etna_session';
export const HINT_COOKIE = 'etna_hint';

export interface SessionHint {
  aal: 'aal1' | 'aal2';
  next: 'aal1' | 'aal2';
  exp: number;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

export async function signHint(hint: SessionHint, secret: string): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(hint)));
  return `${payload}.${toBase64Url(await hmac(secret, payload))}`;
}

export async function readHint(
  value: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<SessionHint | null> {
  if (!value || !secret) return null;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  let expected: Uint8Array;
  let given: Uint8Array;
  try {
    expected = await hmac(secret, payload);
    given = fromBase64Url(signature);
  } catch {
    return null;
  }
  if (expected.length !== given.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i] ^ given[i];
  if (diff !== 0) return null;
  try {
    const hint = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as SessionHint;
    if (typeof hint.exp !== 'number' || hint.exp <= nowSeconds) return null;
    if (
      (hint.aal !== 'aal1' && hint.aal !== 'aal2') ||
      (hint.next !== 'aal1' && hint.next !== 'aal2')
    )
      return null;
    return hint;
  } catch {
    return null;
  }
}
