import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCodeStep, tableFromResult } from '../../src/server/workflow/codeRunner.ts';
import { RUNTIME } from '../../src/lib/workflow/runtime.ts';

// The JavaScript step end to end: a real sandbox process (scripts/server/code-sandbox.mjs).

const table = (rows, meta = {}) => ({ columns: Object.keys(rows[0] ?? {}), rows, meta });
const fails = (promise, key) => assert.rejects(promise, (e) => e.key === key || assert.fail(`${e.key}: ${e.message}`));

test('rows go in, new rows come out; columns in first-seen order, types kept for kept columns', async () => {
  const input = table([{ a: 10, b: 3 }, { a: 5, b: 1 }], { columnTypes: { a: 'number', b: 'number' } });
  const out = await runCodeStep({
    code: 'return rows.filter((r) => r.a > 6).map((r) => ({ a: r.a, margin: r.a - r.b, tag: h.round(1.256, 1) }));',
    table: input,
  });
  assert.deepEqual(out.columns, ['a', 'margin', 'tag']);
  assert.deepEqual(out.rows, [{ a: 10, margin: 7, tag: 1.3 }]);
  assert.deepEqual(out.meta.columnTypes, { a: 'number' });
});

test('nothing of the server is reachable from the code', async () => {
  const out = await runCodeStep({
    code: `return [{
      process: typeof process, require: typeof require, fetch: typeof fetch, std: typeof std, os: typeof os,
      env: (() => { try { return Object.keys(globalThis).filter((k) => !k.startsWith('__')).join(','); } catch { return '?'; } })(),
    }];`,
    table: table([{ a: 1 }]),
  });
  const r = out.rows[0];
  assert.equal(r.process, 'undefined');
  assert.equal(r.require, 'undefined');
  assert.equal(r.fetch, 'undefined');
  // QuickJS's own host modules (files, processes) are not part of the sandbox either.
  assert.equal(r.std, 'undefined');
  assert.equal(r.os, 'undefined');
  assert.doesNotMatch(String(r.env), /DATABASE|SECRET|KEY/i);
});

test('errors in the member’s own words and line numbers; runaway code is stopped', async () => {
  await fails(runCodeStep({ code: 'return [1,\n2 3];', table: table([{ a: 1 }]) }), 'wf.err.code.syntax');
  await assert.rejects(runCodeStep({ code: '\n\nreturn rows.map((r) => r.x.y);', table: table([{ a: 1 }]) }), (e) => e.key === 'wf.err.code.runtime' && e.vars.line === 3);
  await fails(runCodeStep({ code: 'while (true) {}', table: table([{ a: 1 }]), timeoutMs: 300 }), 'wf.err.code.timeout');
  await fails(runCodeStep({ code: 'const a = []; while (true) a.push(new Array(1e5).fill(1));', table: table([{ a: 1 }]) }), 'wf.err.code.memory');
  await fails(runCodeStep({ code: 'return 42;', table: table([{ a: 1 }]) }), 'wf.err.codeNotArray');
  await fails(runCodeStep({ code: 'return [1, 2];', table: table([{ a: 1 }]) }), 'wf.err.codeNotRow');
  await fails(runCodeStep({ code: '   ', table: table([{ a: 1 }]) }), 'wf.err.codeEmpty');
});

test('results are flattened and capped; console.log lines come back as notices', async () => {
  const out = await runCodeStep({
    code: 'console.log("rows", rows.length); return [{ nested: { a: 1 }, list: [1, 2], none: undefined }];',
    table: table([{ a: 1 }]),
  });
  // undefined values do not survive JSON: the key is simply absent.
  assert.deepEqual(out.rows, [{ nested: '{"a":1}', list: '[1,2]' }]);
  assert.ok(out.meta.warnings.some((w) => w.key === 'wf.notice.codeLog' && w.vars.line === 'rows 1'));
  assert.throws(() => tableFromResult(Array.from({ length: 100_001 }, () => ({})), table([])), (e) => e.key === 'wf.err.codeTooManyRows');
  const wide = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`c${i}`, i]));
  assert.throws(() => tableFromResult([wide], table([])), (e) => e.key === 'wf.err.codeTooManyColumns');
});

test('the step needs a server to run on', async () => {
  await fails(RUNTIME['tf.code'].run({ code: 'return rows;' }, [table([{ a: 1 }])], {}), 'wf.err.codeUnavailable');
  const out = await RUNTIME['tf.code'].run({ code: 'return rows;' }, [table([{ a: 1 }])], {
    runCode: ({ code, table: t }) => runCodeStep({ code, table: t }),
  });
  assert.deepEqual(out.rows, [{ a: 1 }]);
});
