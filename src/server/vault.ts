// Secrets of Terminal connections (passwords, API keys, OAuth tokens), sealed
// with AES-256-GCM before they reach the database
// (etna_platform.connection_secrets, 20261012000041). The key is derived
// from MFA_ENCRYPTION_KEY with HKDF for this one purpose, so the app and the
// worker (which run with the same settings) can both open them, and a
// two-factor secret and a connection secret never share a key.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { parseKey } from './auth/secret-box';

let cached: Buffer | null = null;

function vaultKey(): Buffer {
  if (!cached) {
    const base = parseKey(process.env.MFA_ENCRYPTION_KEY);
    cached = Buffer.from(hkdfSync('sha256', base, Buffer.alloc(0), 'etna-connection-vault-v1', 32));
  }
  return cached;
}

/** A JSON value sealed as `v1:<iv>:<tag>:<ciphertext>` (base64). */
export function sealJson(value: unknown, key: Buffer = vaultKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    body.toString('base64'),
  ].join(':');
}

export function openJson<T = Record<string, unknown>>(sealed: string, key: Buffer = vaultKey()): T {
  const [version, iv, tag, body] = sealed.split(':');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')
  ) as T;
}
