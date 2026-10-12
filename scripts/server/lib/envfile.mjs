// KEY=value settings files (etna.env). Comments and blank lines are kept when
// a file is updated; values are never quoted or expanded.

import fs from 'node:fs';

const LINE = /^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/;

export function parseEnv(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(LINE);
    if (m) values[m[1]] = m[2].trim();
  }
  return values;
}

/** Sets (or, with null, removes) keys in the text of an env file. */
export function updateEnv(text, changes) {
  const lines = String(text || '').split(/\r?\n/);
  const done = new Set();
  const out = [];
  for (const line of lines) {
    const m = line.match(LINE);
    if (m && m[1] in changes) {
      if (done.has(m[1])) continue;
      done.add(m[1]);
      if (changes[m[1]] !== null && changes[m[1]] !== undefined) out.push(`${m[1]}=${changes[m[1]]}`);
      continue;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [key, value] of Object.entries(changes)) {
    if (!done.has(key) && value !== null && value !== undefined) out.push(`${key}=${value}`);
  }
  return `${out.join('\r\n')}\r\n`;
}

export function readEnvFile(file) {
  return fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
}

export function writeEnvFile(file, changes) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, updateEnv(text, changes));
}

/** No newline or NUL can enter a value: it would add a setting. */
export function safeValue(value) {
  return !/[\r\n\0]/.test(String(value));
}
