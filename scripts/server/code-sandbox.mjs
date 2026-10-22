#!/usr/bin/env node
// Runs one pipeline code step (tf.code; docs/teknis/WORKFLOWS.md, "Code step")
// and exits. Started by src/server/workflow/codeRunner.ts for each step, with
// no environment at all (no database addresses, keys or paths), and killed
// if it outlives its time.
//
// The member's code runs inside QuickJS (a JavaScript engine compiled to
// WebAssembly): it sees only the rows and columns it is given and a few
// helpers. No require/import, no process, no file system, no network, no
// timers. Memory and stack are capped, and an interrupt handler stops it at
// its deadline.
//
// stdin:  {"code": "...", "rows": [...], "columns": [...], "timeoutMs": 10000, "memoryMb": 128}
// stdout: {"ok": true, "rows": [...], "logs": [...]}
//      or {"ok": false, "error": {"kind": "syntax"|"runtime"|"timeout"|"memory"|"result", "message": "...", "line": 3}}

import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

const MAX_LOGS = 50;

// The code becomes the body of a function of (rows, columns, h). This many
// lines come before it, to give error lines in the member's own numbering.
const PRELUDE = `"use strict";
const __in = JSON.parse(__input);
const __logs = [];
const __show = (v) => (typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })());
const console = Object.freeze({ log: (...a) => { if (__logs.length < ${MAX_LOGS}) __logs.push(a.map(__show).join(' ').slice(0, 500)); } });
const h = Object.freeze({
  num: (v) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; },
  round: (v, d = 0) => { const p = 10 ** d; return Math.round(Number(v) * p) / p; },
  sum: (xs) => xs.reduce((s, v) => s + (Number(v) || 0), 0),
  avg: (xs) => { const n = xs.map(Number).filter(Number.isFinite); return n.length ? n.reduce((s, v) => s + v, 0) / n.length : null; },
  groupBy: (xs, key) => { const m = {}; for (const x of xs) { const k = String(typeof key === 'function' ? key(x) : x[key]); (m[k] ||= []).push(x); } return m; },
  date: (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); },
  daysBetween: (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000),
});
const __fn = function (rows, columns, h) {
`;
const PRELUDE_LINES = PRELUDE.split('\n').length - 1;
const EPILOGUE = `
};
JSON.stringify({ rows: __fn(__in.rows, __in.columns, h), logs: __logs });`;

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const reply = (value) =>
  new Promise((resolve) => process.stdout.write(JSON.stringify(value), () => resolve()));

function lineOf(stack) {
  const m = /:(\d+)(?::\d+)?\)?\s*$/m.exec(String(stack ?? ''));
  if (!m) return undefined;
  const line = Number(m[1]) - PRELUDE_LINES;
  return line > 0 ? line : undefined;
}

async function main() {
  const input = await readInput();
  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 10_000, 100), 60_000);
  const memoryMb = Math.min(Math.max(Number(input.memoryMb) || 128, 16), 512);
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryMb * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const vm = runtime.newContext();
  try {
    const data = vm.newString(JSON.stringify({ rows: input.rows ?? [], columns: input.columns ?? [] }));
    vm.setProp(vm.global, '__input', data);
    data.dispose();
    const result = vm.evalCode(PRELUDE + String(input.code ?? '') + EPILOGUE, 'step.js');
    if (result.error) {
      const e = vm.dump(result.error);
      result.error.dispose();
      const message = String(e?.message ?? e ?? 'error');
      const kind =
        Date.now() >= deadline || /interrupted/i.test(message)
          ? 'timeout'
          : /out of memory/i.test(message)
            ? 'memory'
            : e?.name === 'SyntaxError'
              ? 'syntax'
              : 'runtime';
      return reply({ ok: false, error: { kind, message: message.slice(0, 500), line: lineOf(e?.stack) } });
    }
    const text = vm.getString(result.value);
    result.value.dispose();
    const out = JSON.parse(text);
    return reply({ ok: true, rows: out.rows, logs: out.logs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({
      ok: false,
      error: { kind: /memory/i.test(message) ? 'memory' : 'result', message: message.slice(0, 500) },
    });
  } finally {
    try {
      vm.dispose();
      runtime.dispose();
    } catch {
      // a step stopped mid-way may leave handles behind; the process ends anyway
    }
  }
}

main().then(
  () => process.exit(0),
  async (error) => {
    await reply({ ok: false, error: { kind: 'result', message: String(error?.message ?? error).slice(0, 500) } });
    process.exit(0);
  }
);
