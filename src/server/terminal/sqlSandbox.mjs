// What the Query Tool's runs share (src/server/terminal/sqlJobs.ts and the
// sandbox thread, sqlSandboxThread.mjs): how a query is wrapped, and its error
// positions given back in the query as written. Plain JavaScript: a worker
// thread loads it without the worker's TypeScript loader.

/** Statements whose rows are read through a cursor (any size; the first rows are kept). */
export const CURSOR_RE = /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(select|with|values|table)\b/i;
export const CURSOR_PREFIX = 'DECLARE ps_query NO SCROLL CURSOR FOR ';
export const EXPLAIN_PREFIX = {
  explain: 'EXPLAIN (FORMAT TEXT) ',
  analyze: 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ',
};

/**
 * An error's position in the query as written: PostgreSQL counts from 1 in
 * the text it was sent, which had `prefix` characters before the query.
 * @template {{ position: number | null }} E
 * @param {E} error
 * @param {number} prefix
 * @returns {E}
 */
export function shift(error, prefix) {
  if (!error.position) return error;
  const p = error.position - prefix;
  return { ...error, position: p > 0 ? p : null };
}

/**
 * A database error as the Query Tool shows it.
 * @param {any} e
 */
export function errorOf(e) {
  return {
    code: e?.code ? String(e.code) : null,
    message: String(e?.message ?? e ?? 'Error').slice(0, 2000),
    position: e?.position ? Number(e.position) : null,
    hint: e?.hint ? String(e.hint).slice(0, 500) : null,
    detail: e?.detail ? String(e.detail).slice(0, 500) : null,
  };
}
