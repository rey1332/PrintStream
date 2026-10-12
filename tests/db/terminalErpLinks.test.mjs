import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, expectError } from './harness.mjs';

let db;
let owner;
let terminal;
let erp;
let link;

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'link-owner');
  [{ workspace_id: erp }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
  [{ id: terminal }] = await run(db, owner, `select erp_create_terminal('Data tambang') as id`);
});

test('the Owner of both links a TERMINAL to an ERP; both logs record it', async () => {
  [{ id: link }] = await run(db, owner, `select ps_link_erp($1, $2) as id`, [terminal, erp]);
  const [row] = await run(db, owner, `select workspace_id, erp_workspace_id, erp_name from ps_erp_links where id = $1`, [link]);
  assert.equal(row.erp_workspace_id, erp);
  const logs = (await db.query(`select workspace_id, action from erp_workspace_audit_log where details ->> 'link_id' = $1 order by action`, [link])).rows;
  assert.deepEqual(logs.map((l) => l.action), ['erp_link.added', 'terminal_link.added']);
  // Linking again keeps one link; an ERP is not linked to an ERP, nor without two-factor.
  const [{ id: again }] = await run(db, owner, `select ps_link_erp($1, $2) as id`, [terminal, erp]);
  assert.equal(again, link);
  await expectError(run(db, owner, `select ps_link_erp($1, $2)`, [erp, erp]), /TERMINAL/);
  await expectError(run(db, { ...owner, aal: 'aal1' }, `select ps_link_erp($1, $2)`, [terminal, erp]), /two-factor/);
});

test('someone who is not an Admin of the ERP cannot link it; members see links, others do not', async () => {
  const other = await createUser(db, 'link-other');
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation_v2($1, 'admin', 24, '', null)`, [terminal]);
  await run(db, other, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  // An Admin of the TERMINAL, not a member of the ERP.
  await expectError(run(db, other, `select ps_link_erp($1, $2)`, [terminal, erp]), /Owner or an Admin/);
  assert.equal((await run(db, other, `select count(*)::int n from ps_erp_links`))[0].n, 1);
  const stranger = await createUser(db, 'link-stranger');
  assert.equal((await run(db, stranger, `select count(*)::int n from ps_erp_links`))[0].n, 0);
  await expectError(run(db, stranger, `select ps_unlink_erp($1)`, [link]), /not allowed|not found/);
});

test('either side removes the link', async () => {
  await run(db, owner, `select ps_unlink_erp($1)`, [link]);
  assert.equal((await run(db, owner, `select count(*)::int n from ps_erp_links`))[0].n, 0);
});

test('rollback removes links', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000044_terminal_erp_links.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select to_regclass('public.ps_erp_links') is null as gone`);
  assert.equal(rows[0].gone, true);
  await d.close();
});

test('a pipeline adds rows to a linked ERP list: new ones added, known ones skipped or updated', async () => {
  const { writeErpList } = await import('../../src/server/terminal/erpLinks.ts');
  const executor = { transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })) };
  const identity = { userId: owner.id, email: owner.email, aal: 'aal2' };
  const [{ id: l2 }] = await run(db, owner, `select ps_link_erp($1, $2) as id`, [terminal, erp]);
  const rows = (names) => ({ columns: ['Name', 'city', 'note'], rows: names.map(([name, city]) => ({ Name: name, city, note: 'x' })) });

  const r1 = await writeErpList(executor, identity, terminal, erp, 'customers', 'add_new', rows([['PT Satu', 'Bogor'], ['PT Dua', 'Depok'], ['', 'Nowhere']]));
  assert.deepEqual(r1, { added: 2, updated: 0, skipped: 0, rejected: 1 });
  const r2 = await writeErpList(executor, identity, terminal, erp, 'customers', 'add_new', rows([['pt satu', 'Bandung'], ['PT Tiga', 'Bekasi']]));
  assert.deepEqual(r2, { added: 1, updated: 0, skipped: 1, rejected: 0 });
  const r3 = await writeErpList(executor, identity, terminal, erp, 'customers', 'add_or_update', rows([['PT Satu', 'Bandung']]));
  assert.deepEqual(r3, { added: 0, updated: 1, skipped: 0, rejected: 0 });
  const saved = (await db.query(`select name, city from erp_customers where workspace_id = $1 order by name`, [erp])).rows;
  assert.deepEqual(saved, [
    { name: 'PT Dua', city: 'Depok' },
    { name: 'PT Satu', city: 'Bandung' },
    { name: 'PT Tiga', city: 'Bekasi' },
  ]);

  // Not linked any more: refused.
  await run(db, owner, `select ps_unlink_erp($1)`, [l2]);
  await assert.rejects(
    writeErpList(executor, identity, terminal, erp, 'customers', 'add_new', rows([['PT Empat', 'Bogor']])),
    (e) => e.key === 'wf.err.erpNotLinked' || /not linked/i.test(e.message)
  );
});

test('an ERP made with its own owner account (erp_create_erp_v2) takes rows from a pipeline too', async () => {
  const { writeErpList } = await import('../../src/server/terminal/erpLinks.ts');
  const executor = { transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })) };
  const identity = { userId: owner.id, email: owner.email, aal: 'aal2' };
  const [{ id: own }] = await run(db, owner, `select erp_create_erp_v2('ERP sendiri', 'general') as id`);
  const [{ owner_id }] = (await db.query(`select owner_id from erp_workspaces where id = $1`, [own])).rows;
  assert.notEqual(owner_id, owner.id);
  const [{ id: link }] = await run(db, owner, `select ps_link_erp($1, $2) as id`, [terminal, own]);
  const r = await writeErpList(executor, identity, terminal, own, 'customers', 'add_new', {
    columns: ['name'],
    rows: [{ name: 'PT Kontainer' }],
  });
  assert.deepEqual(r, { added: 1, updated: 0, skipped: 0, rejected: 0 });
  const saved = (await db.query(`select name, user_id from erp_customers where workspace_id = $1`, [own])).rows;
  assert.deepEqual(saved, [{ name: 'PT Kontainer', user_id: owner_id }]);
  await run(db, owner, `select ps_unlink_erp($1)`, [link]);
});
