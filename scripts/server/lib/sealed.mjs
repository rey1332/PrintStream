// The secrets in a full backup (etna.env: the two-factor key, the session
// secret, database passwords) are sealed so that a backup can be made without
// anyone typing a passphrase (the nightly task), but only opened with it.
//
// At installation an RSA key pair is made. The public key seals every
// backup's secrets (AES-256-GCM with a random key, the key wrapped with
// RSA-OAEP/SHA-256). The private key is stored encrypted with the admin's
// passphrase (PKCS#8, AES-256-CBC, key derived with scrypt by Node) and goes
// into every backup too, so a backup plus the passphrase is all a restore needs.

import crypto from 'node:crypto';

export const MIN_PASSPHRASE = 12;

export function newBackupKeys(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`The passphrase needs at least ${MIN_PASSPHRASE} characters.`);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
  });
  return { publicKey, privateKey };
}

export function seal(plaintext, publicKeyPem) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const wrapped = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    key
  );
  return JSON.stringify({
    format: 'etna-sealed-1',
    key: wrapped.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

/** Opens a sealed text; throws 'wrong_passphrase' or 'damaged'. */
export function unseal(sealedJson, privateKeyPem, passphrase) {
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: privateKeyPem, format: 'pem', passphrase });
  } catch {
    throw new Error('wrong_passphrase');
  }
  try {
    const s = JSON.parse(sealedJson);
    if (s.format !== 'etna-sealed-1') throw new Error('format');
    const key = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(s.key, 'base64')
    );
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('damaged');
  }
}

/** Whether a passphrase opens a stored private key. */
export function passphraseOpens(privateKeyPem, passphrase) {
  try {
    crypto.createPrivateKey({ key: privateKeyPem, format: 'pem', passphrase });
    return true;
  } catch {
    return false;
  }
}
