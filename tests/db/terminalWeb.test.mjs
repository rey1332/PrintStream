import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, expectError } from './harness.mjs';

let db;
let owner;
let ws;
let site;

const COLUMNS = JSON.stringify([
  { label: 'Produk', type: 'text', key: true },
  { label: 'Harga', type: 'decimal' },
  { label: '_url', type: 'text' },
]);
const source = (extra = {}) =>
  JSON.stringify({
    mode: 'web',
    format: 'table',
    pages: 'urls',
    urls: ['/harga'],
    max_pages: 10,
    key: 'Produk',
    ...extra,
  });

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'web-owner');
  [{ workspace_id: ws }] = await run(
    db,
    owner,
    `select workspace_id from erp_my_workspaces() where is_personal`
  );
  await run(db, owner, `select erp_set_terminal($1, true)`, [ws]);
  [{ id: site }] = await run(
    db,
    owner,
    `select ps_save_connection($1, null, 'web', 'Supplier', '{"base_url":"https://www.supplier.example"}'::jsonb, null) as id`,
    [ws]
  );
});

test('a website connection syncs sources, each into its own dataset, with integrations.use', async () => {
  const create = (who, src, name) =>
    run(
      db,
      who,
      `select ps_create_source_sync($1, $2::jsonb, 'TABLE · /harga', $3, $4::jsonb) as id`,
      [site, src, name, COLUMNS]
    );
  // Reading public pages changes nothing: a one-factor session is enough.
  const [{ id }] = await create({ ...owner, aal: 'aal1' }, source(), 'Harga supplier');
  const [row] = await run(
    db,
    owner,
    `select object, source ->> 'format' as f from ps_syncs where id = $1`,
    [id]
  );
  assert.deepEqual(row, { object: 'web', f: 'table' });
  await create(owner, source({ format: 'feed', urls: ['/feed.xml'], key: null }), 'Berita');
  await expectError(create(owner, source({ format: 'script' }), 'X'), /names what it reads/);
  await expectError(
    create(owner, JSON.stringify({ mode: 'rest', method: 'GET', path: '/x' }), 'Y'),
    /Not a source of this connection/
  );
});

test('rollback removes website connections', async () => {
  const d = await createDb();
  await d.exec(
    readFileSync(
      new URL('../../db/rollback/rollback_20261012000047_terminal_web.sql', import.meta.url),
      'utf8'
    )
  );
  const { rows } = await d.query(
    `select pg_get_constraintdef(oid) as kinds from pg_constraint where conname = 'ps_connections_kind_check'`
  );
  assert.doesNotMatch(rows[0].kinds, /'web'/);
  assert.match(rows[0].kinds, /'rest'/);
  await d.close();
});
