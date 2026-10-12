// Console input and output for the server manager (Command Prompt).

import readline from 'node:readline';

const color = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = color(32);
export const red = color(31);
export const yellow = color(33);
export const bold = color(1);
export const dim = color(2);

// One reader for the whole session, so lines typed (or piped) ahead are kept.
let rl = null;
let muted = false;
let closed = false;
let waiting = null;
const pending = [];

function reader() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    // Echo nothing while a password is typed.
    rl._writeToOutput = (s) => {
      if (!muted) rl.output.write(s);
    };
    rl.on('line', (text) => {
      if (waiting) {
        const done = waiting;
        waiting = null;
        done(text);
      } else pending.push(text);
    });
    rl.on('close', () => {
      closed = true;
      // No more input (window closed, or the end of piped input): leave.
      if (waiting || pending.length === 0) process.exit(0);
    });
  }
  return rl;
}

export function ask(question, { hidden = false } = {}) {
  reader();
  process.stdout.write(question);
  return new Promise((resolve) => {
    const done = (text) => {
      muted = false;
      if (hidden) process.stdout.write('\n');
      resolve(String(text).trim());
    };
    muted = hidden;
    if (pending.length) done(pending.shift());
    else if (closed) process.exit(0);
    else waiting = done;
  });
}

export function close() {
  rl?.close();
}

/** Yes/no; `yes` and `no` are the letters accepted in the chosen language. */
export async function confirm(question, { yes = 'y', no = 'n', fallback = false } = {}) {
  for (;;) {
    const a = (await ask(`${question} [${yes.toUpperCase()}/${no.toUpperCase()}]: `)).toLowerCase();
    if (!a) return fallback;
    if (a === yes || a === 'y') return true;
    if (a === no || a === 'n') return false;
  }
}

/** Picks one of `options` ([{ key, label }]) by its key; '' returns `fallback`. */
export async function choose(question, options, fallback = null) {
  for (;;) {
    for (const o of options) console.log(`  [${o.key}] ${o.label}`);
    const a = (await ask(`${question} `)).toLowerCase();
    if (!a && fallback !== null) return fallback;
    const hit = options.find((o) => String(o.key).toLowerCase() === a);
    if (hit) return hit.key;
  }
}

/** A password typed twice, hidden; null when the admin gives up (empty). */
export async function newSecret(prompt, again, mismatch, tooShort, minLength) {
  for (;;) {
    const first = await ask(prompt, { hidden: true });
    if (!first) return null;
    if (first.length < minLength) {
      console.log(red(tooShort));
      continue;
    }
    const second = await ask(again, { hidden: true });
    if (first === second) return first;
    console.log(red(mismatch));
  }
}

export const line = (width = 48) => console.log('='.repeat(width));

export function title(text, width = 48) {
  line(width);
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  console.log(bold(' '.repeat(pad) + text));
  line(width);
}

export const step = (text) => process.stdout.write(`  [..] ${text}`);
export const stepDone = () => process.stdout.write(`\r  [${green('OK')}]\n`);
export const stepFailed = () => process.stdout.write(`\r  [${red('!!')}]\n`);

export async function pause(message) {
  await ask(dim(message));
}
