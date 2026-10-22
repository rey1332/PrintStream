import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

// JavaScript steps in pipelines (20261012000061): off by default, switched by
// the Owner, written only with "Write pipeline code", never through MCP.

let db;
let owner;
let ws;

const node = (id, type, config) => ({ id, type: 'workflowNode', position: { x: 0, y: 0 }, data: { type, label: type, config } });
const graph = (code, extra = []) =>
  JSON.stringify({
    nodes: [node('lim', 'tf.limit', { n: 5 }), ...(code === null ? [] : [node('js', 'tf.code', { code })]), ...extra],
    edges: [],
  });
const insert = (user, g, name = 'Kode') =>
  run(db, user, `insert into workflows (user_id, workspace_id, name, graph) values ($1, $2, $3, $4::jsonb) returning id`, [user.id, ws, name, g]).then((r) => r[0].id);
const save = (user, id, g) => run(db, user, `update workflows set graph = $2::jsonb where id = $1`, [id, g]);
const audit = (action) =>
  admin(db, `select details from erp_workspace_audit_log where workspace_id = $1 and action = $2 order by created_at`, [ws, action]);

async function join(role, customId = null) {
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation_v2($1, $2, 24, '', $3)`, [ws, role, customId]);
  const user = await createUser(db, `code-${role}`);
  await run(db, user, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  return user;
}

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'code-owner');
  [{ id: ws }] = await run(db, owner, `select erp_create_terminal('Data tambang') as id`);
});

test('off by default: no code can be saved, and runs are told so', async () => {
  assert.equal((await run(db, owner, `select ps_pipeline_code_enabled($1) as on`, [ws]))[0].on, false);
  await expectError(insert(owner, graph('return rows;')), /switched off/);
  // A pipeline without code is untouched by all this.
  const id = await insert(owner, graph(null));
  await save(owner, id, graph(null, [node('lim2', 'tf.limit', { n: 3 })]));
});

test('only the Owner, with two-factor, switches it; both ways are in the audit log', async () => {
  const admin_ = await join('admin');
  await expectError(run(db, admin_, `select ps_set_pipeline_code($1, true)`, [ws]), /Only the Owner/);
  await expectError(run(db, { ...owner, aal: 'aal1' }, `select ps_set_pipeline_code($1, true)`, [ws]), /two-factor|Two-factor/i);
  await run(db, owner, `select ps_set_pipeline_code($1, true)`, [ws]);
  assert.equal((await run(db, admin_, `select ps_pipeline_code_enabled($1) as on`, [ws]))[0].on, true);
  assert.equal((await audit('pipeline.codeEnabled')).length, 1);
  // A stranger learns nothing.
  const stranger = await createUser(db, 'code-stranger');
  assert.equal((await run(db, stranger, `select ps_pipeline_code_enabled($1) as on`, [ws]))[0].on, false);
});

test('writing code needs "Write pipeline code" and two-factor; each change is audited with its hash', async () => {
  const code = 'return rows.map((r) => ({ ...r, x: 1 }));';
  const id = await insert(owner, graph(code));
  const [entry] = await audit('pipeline.codeChanged');
  assert.equal(entry.details.node_id, 'js');
  assert.equal(entry.details.sha256, createHash('sha256').update(code).digest('hex'));
  assert.equal(entry.details.length, code.length);

  // Admins have every other pipeline right, but not this one.
  const admin_ = await join('admin');
  const [{ p }] = await run(db, admin_, `select erp_has_permission($1, 'pipelines.code') as p`, [ws]);
  assert.equal(p, false);
  await expectError(insert(admin_, graph('return [];')), /Write pipeline code/);
  // ...but they may change the rest of a pipeline whose code stays as it is.
  await run(db, owner, `update workflows set access = 'workspace' where id = $1`, [id]);
  const kept = JSON.parse(graph(code, [node('lim3', 'tf.limit', { n: 2 })]));
  await save(owner, id, JSON.stringify(kept));
  // Removing a code step needs no right (it runs nothing).
  await save(owner, id, graph(null));

  // A custom role given the permission may write code, with two-factor.
  const [{ id: roleId }] = await run(db, owner, `select erp_save_custom_role($1, null, 'Analis kode', '', $2, true) as id`, [
    ws, ['read', 'pipelines.view', 'pipelines.create', 'pipelines.edit', 'pipelines.run', 'pipelines.code'],
  ]);
  const analyst = await join('custom', roleId);
  await insert(analyst, graph('return rows;'), 'Analis');
  await expectError(insert({ ...analyst, aal: 'aal1' }, graph('return [1];'), 'Tanpa 2FA'), /two-factor|Two-factor|permission|not allowed/i);
  // The permission makes a role need two-factor.
  await expectError(
    run(db, owner, `select erp_save_custom_role($1, null, 'Tanpa 2FA', '', $2, false)`, [ws, ['pipelines.code']]),
    /check|two-factor|requires/i
  );
});

test('switched off again: saving new code stops, the switch is audited', async () => {
  await run(db, owner, `select ps_set_pipeline_code($1, false)`, [ws]);
  await expectError(insert(owner, graph('return rows;')), /switched off/);
  assert.equal((await audit('pipeline.codeDisabled')).length, 1);
  await run(db, owner, `select ps_set_pipeline_code($1, true)`, [ws]);
});

test('an MCP connection never adds or changes code, but keeps what a person wrote', async () => {
  const hash = (v) => createHash('sha256').update(v).digest('hex');
  const value = `psmcp_${randomBytes(32).toString('base64url')}`;
  const [{ id: tokenId }] = await run(db, owner, `select ps_mcp_token_create_v2($1, 'Claude', $2, $3, 30, true) as id`, [ws, hash(value), value.slice(0, 12)]);
  await expectError(
    run(db, owner, `select * from ps_mcp_pipeline_create($1, $2, 'Dari Claude', '', $3::jsonb)`, [tokenId, ws, graph('return rows;')]),
    /cannot write pipeline code/
  );
  const [{ id }] = await run(db, owner, `select * from ps_mcp_pipeline_create($1, $2, 'Dari Claude', '', $3::jsonb)`, [tokenId, ws, graph(null)]);
  // A person adds code in the editor; the assistant may change other steps around it.
  await save(owner, id, graph('return rows;'));
  const [{ updated_at: at }] = await admin(db, `select updated_at from workflows where id = $1`, [id]);
  await run(db, owner, `select ps_mcp_pipeline_update($1, $2, $3, $4::jsonb)`, [tokenId, id, at, graph('return rows;', [node('lim4', 'tf.limit', { n: 1 })])]);
  const [{ at: at2 }] = await admin(db, `select updated_at as at from workflows where id = $1`, [id]);
  await expectError(
    run(db, owner, `select ps_mcp_pipeline_update($1, $2, $3, $4::jsonb)`, [tokenId, id, at2, graph('return [];')]),
    /cannot write pipeline code/
  );
});

test('rollback removes the switch, the guard and the permission', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000061_pipeline_code.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(
    `select not ('pipelines.code' = any (public.erp_all_permissions())) as perm_gone,
            to_regprocedure('public.ps_set_pipeline_code(uuid,boolean)') is null as fn_gone,
            not exists (select 1 from pg_trigger where tgname = 'trg_workflow_code_guard') as trigger_gone,
            not exists (select 1 from information_schema.columns where table_name = 'erp_workspaces' and column_name = 'pipeline_code_enabled') as column_gone`
  );
  assert.deepEqual(rows[0], { perm_gone: true, fn_gone: true, trigger_gone: true, column_gone: true });
  await d.close();
});
