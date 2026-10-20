// Off-site backup files (scripts/db/offsite.mjs, docs/teknis/OPERATIONS.md §3).
//
// One file holds everything a restore needs: the database dump, the uploaded
// documents and company folders, and optionally the settings (etna.env). It
// is encrypted so that the nightly job needs no passphrase, but only someone
// with the passphrase can open it:
//
//   "ETNAOFF1"                     8 bytes
//   header length                  u32, big-endian
//   header (JSON, readable)        format, created, the AES key wrapped with
//                                  the backup public key (RSA-OAEP/SHA-256),
//                                  the IV, and the private key encrypted with
//                                  the passphrase (so file + passphrase is
//                                  all a restore needs)
//   ciphertext                     AES-256-GCM of the entries
//   tag                            16 bytes
//
// Entries: u16 name length, name (UTF-8), u64 size, bytes; a zero name
// length ends them. The last entry is manifest.json with every other entry's
// size and SHA-256. Reading checks each hash, the manifest and the GCM tag;
// anything changed in the file is refused.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const FORMAT = 'etna-offsite-1';
const MAGIC = Buffer.from('ETNAOFF1');
const TAG_BYTES = 16;
export const BUNDLE_NAME = /^etna-offsite-(\d{8})-(\d{6})\.etnabak$/;

const pad = (n) => String(n).padStart(2, '0');
export function bundleName(date = new Date()) {
  return `etna-offsite-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.etnabak`;
}

export function listBundles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => BUNDLE_NAME.test(name))
    .sort()
    .reverse()
    .map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size }));
}

/** Names to delete so that `keep` bundles remain (the newest). */
export const bundlesToPrune = (bundles, keep) => bundles.slice(Math.max(1, keep)).map((b) => b.name);

/** Entry names: relative, forward slashes, no "..", no absolute paths. */
export function safeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 1024) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\') || name.includes('\0')) return false;
  return name.split('/').every((part) => part && part !== '.' && part !== '..');
}

/** Every file under `dir` as { name: `${prefix}/relative/path`, file }. */
export function filesUnder(dir, prefix) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  const walk = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, name);
      else if (entry.isFile()) out.push({ name: `${prefix}/${name}`, file: abs });
    }
  };
  walk(dir, '');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function entryHead(name, size) {
  const bytes = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(2 + bytes.length + 8);
  head.writeUInt16BE(bytes.length, 0);
  bytes.copy(head, 2);
  head.writeBigUInt64BE(BigInt(size), 2 + bytes.length);
  return head;
}

/**
 * Writes an encrypted bundle of `entries` ({ name, file } or { name, data }).
 * `info` goes into the manifest. Returns the manifest.
 */
export async function writeBundle(target, entries, { publicKey, privateKeyEncrypted, info = {} }) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const header = Buffer.from(
    JSON.stringify({
      format: FORMAT,
      created: new Date().toISOString(),
      key: crypto
        .publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key)
        .toString('base64'),
      iv: iv.toString('base64'),
      privateKey: privateKeyEncrypted,
    }),
    'utf8'
  );
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
  const write = (chunk) =>
    new Promise((resolve, reject) => (out.write(chunk, (e) => (e ? reject(e) : resolve())), undefined));
  const files = [];
  try {
    const lengthBytes = Buffer.alloc(4);
    lengthBytes.writeUInt32BE(header.length);
    await write(Buffer.concat([MAGIC, lengthBytes, header]));
    const put = async (name, size, source) => {
      if (!safeEntryName(name)) throw new Error(`Unsafe entry name: ${name}`);
      await write(cipher.update(entryHead(name, size)));
      const hash = crypto.createHash('sha256');
      let written = 0;
      for await (const chunk of source) {
        hash.update(chunk);
        written += chunk.length;
        await write(cipher.update(chunk));
      }
      if (written !== size) throw new Error(`${name} changed while it was being backed up`);
      return hash.digest('hex');
    };
    for (const entry of entries) {
      if (entry.name === 'manifest.json') throw new Error('manifest.json is written by the bundle itself');
      const data = entry.data !== undefined ? Buffer.from(entry.data) : null;
      const size = data ? data.length : fs.statSync(entry.file).size;
      const sha256 = await put(entry.name, size, data ? [data] : fs.createReadStream(entry.file));
      files.push({ name: entry.name, size, sha256 });
    }
    const manifest = { format: FORMAT, createdAt: new Date().toISOString(), ...info, entries: files };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    await put('manifest.json', manifestBytes.length, [manifestBytes]);
    await write(cipher.update(Buffer.alloc(2)));
    await write(cipher.final());
    await write(cipher.getAuthTag());
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    return manifest;
  } catch (error) {
    out.destroy();
    fs.rmSync(target, { force: true });
    throw error;
  }
}

/** The readable header of a bundle (no passphrase needed). */
export function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const start = Buffer.alloc(12);
    if (fs.readSync(fd, start, 0, 12, 0) !== 12 || !start.subarray(0, 8).equals(MAGIC)) throw new Error('not_a_bundle');
    const length = start.readUInt32BE(8);
    if (length > 1_000_000) throw new Error('not_a_bundle');
    const header = Buffer.alloc(length);
    fs.readSync(fd, header, 0, length, 12);
    const parsed = JSON.parse(header.toString('utf8'));
    if (parsed.format !== FORMAT) throw new Error('not_a_bundle');
    return { header: parsed, offset: 12 + length };
  } finally {
    fs.closeSync(fd);
  }
}

/** Parses decrypted entry bytes as they arrive; calls onEntry(name, size) then onData(chunk), onEnd(). */
class EntryParser {
  constructor(handlers) {
    this.h = handlers;
    this.buffer = Buffer.alloc(0);
    this.state = 'head';
    this.remaining = 0n;
    this.done = false;
  }
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.done) {
        if (this.buffer.length) throw new Error('damaged');
        return;
      }
      if (this.state === 'head') {
        if (this.buffer.length < 2) return;
        const nameLength = this.buffer.readUInt16BE(0);
        if (nameLength === 0) {
          this.done = true;
          this.buffer = this.buffer.subarray(2);
          continue;
        }
        if (this.buffer.length < 2 + nameLength + 8) return;
        const name = this.buffer.subarray(2, 2 + nameLength).toString('utf8');
        this.remaining = this.buffer.readBigUInt64BE(2 + nameLength);
        this.buffer = this.buffer.subarray(2 + nameLength + 8);
        if (!safeEntryName(name)) throw new Error('damaged');
        this.h.onEntry(name, Number(this.remaining));
        this.state = 'data';
        if (this.remaining === 0n) {
          this.h.onEnd();
          this.state = 'head';
        }
        continue;
      }
      if (!this.buffer.length) return;
      const take = this.remaining < BigInt(this.buffer.length) ? Number(this.remaining) : this.buffer.length;
      this.h.onData(this.buffer.subarray(0, take));
      this.buffer = this.buffer.subarray(take);
      this.remaining -= BigInt(take);
      if (this.remaining === 0n) {
        this.h.onEnd();
        this.state = 'head';
      }
    }
  }
}

/**
 * Decrypts and checks a bundle. With `into`, writes the entries below that
 * folder (to <into>.partial first; renamed only when everything checked out).
 * Throws 'wrong_passphrase', 'damaged' or 'not_a_bundle'. Returns the manifest.
 */
export async function readBundle(file, passphrase, { into = null } = {}) {
  const { header, offset } = readHeader(file);
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: header.privateKey, format: 'pem', passphrase });
  } catch {
    throw new Error('wrong_passphrase');
  }
  let key;
  try {
    key = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(header.key, 'base64')
    );
  } catch {
    throw new Error('damaged');
  }
  const size = fs.statSync(file).size;
  if (size < offset + TAG_BYTES + 2) throw new Error('damaged');
  const tag = Buffer.alloc(TAG_BYTES);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
  fs.closeSync(fd);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decipher.setAuthTag(tag);

  const staging = into ? `${path.resolve(into)}.partial` : null;
  if (staging) {
    if (fs.existsSync(into)) throw new Error(`${into} already exists`);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
  }
  const seen = [];
  let manifestBytes = null;
  let current = null;
  const parser = new EntryParser({
    onEntry(name, entrySize) {
      current = { name, size: entrySize, hash: crypto.createHash('sha256'), chunks: name === 'manifest.json' ? [] : null, fd: null };
      if (staging && name !== 'manifest.json') {
        const target = path.join(staging, ...name.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        current.fd = fs.openSync(target, 'wx', 0o600);
      }
    },
    onData(chunk) {
      current.hash.update(chunk);
      if (current.chunks) current.chunks.push(Buffer.from(chunk));
      if (current.fd !== null) fs.writeSync(current.fd, chunk);
    },
    onEnd() {
      if (current.fd !== null) fs.closeSync(current.fd);
      if (current.chunks) manifestBytes = Buffer.concat(current.chunks);
      else seen.push({ name: current.name, size: current.size, sha256: current.hash.digest('hex') });
      current = null;
    },
  });
  try {
    try {
      await pipeline(fs.createReadStream(file, { start: offset, end: size - TAG_BYTES - 1 }), async function* (source) {
        for await (const chunk of source) parser.push(decipher.update(chunk));
        parser.push(decipher.final());
      });
    } catch (error) {
      if (current?.fd) fs.closeSync(current.fd);
      // A full disk is not a damaged backup.
      if (typeof error?.code === 'string' && error.code.startsWith('E')) throw error;
      throw new Error('damaged');
    }
    if (!parser.done || !manifestBytes) throw new Error('damaged');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const listed = JSON.stringify((manifest.entries ?? []).map((e) => [e.name, e.size, e.sha256]));
    if (manifest.format !== FORMAT || listed !== JSON.stringify(seen.map((e) => [e.name, e.size, e.sha256])))
      throw new Error('damaged');
    if (staging) {
      fs.writeFileSync(path.join(staging, 'manifest.json'), manifestBytes, { mode: 0o600 });
      fs.renameSync(staging, into);
    }
    return manifest;
  } catch (error) {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
