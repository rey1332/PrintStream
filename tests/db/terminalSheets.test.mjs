import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, expectError } from './harness.mjs';

// Spreadsheets online as a connection (20261012000063).

let db;
let owner;
let ws;
let sheet;

const COLUMNS = JSON.stringify([
  { label: 'Kode', type: 'text', key: true },
  { label: 'Produk', type: 'text' },
  { label: 'Harga', type: 'decimal' },
]);
const URL_ = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0';
const source = (extra = {}) =>
  JSON.stringify({ mode: 'sheet', url: URL_, sheet: 'Harga', range: null, header_row: 1, key: 'Kode', ...extra });

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'sheets-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
  await run(db, owner, `select erp_set_terminal($1, true)`, [ws]);
  [{ id: sheet }] = await run(
    db,
    owner,
    `select ps_save_connection($1, null, 'sheets', 'Harga supplier', '{"provider":"google","google_auth":"link"}'::jsonb, null) as id`,
    [ws]
  );
});

test('a spreadsheet connection syncs tabs, each into its own dataset, with integrations.use', async () => {
  const create = (who, src, name) =>
    run(db, who, `select ps_create_source_sync($1, $2::jsonb, 'Harga', $3, $4::jsonb) as id`, [sheet, src, name, COLUMNS]);
  // Reading a sheet changes nothing there: a one-factor session is enough.
  const [{ id }] = await create({ ...owner, aal: 'aal1' }, source(), 'Harga dari sheet');
  const [row] = await run(db, owner, `select object, source ->> 'sheet' as tab from ps_syncs where id = $1`, [id]);
  assert.deepEqual(row, { object: 'sheet', tab: 'Harga' });
  await expectError(create(owner, source({ url: '' }), 'Kosong'), /names its sheet/);
  await expectError(create(owner, JSON.stringify({ mode: 'web', format: 'table', pages: 'urls', urls: ['/'] }), 'Y'), /Not a source of this connection/);
  // A stranger cannot use the connection.
  const stranger = await createUser(db, 'sheets-stranger');
  await expectError(create(stranger, source(), 'Z'), /Connection not found/);
});

test('rollback removes spreadsheet connections and puts the kinds back', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000063_terminal_sheets.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select pg_get_constraintdef(oid) as kinds from pg_constraint where conname = 'ps_connections_kind_check'`);
  assert.doesNotMatch(rows[0].kinds, /'sheets'/);
  assert.match(rows[0].kinds, /'mcp'/);
  const { rows: fn } = await d.query(
    `select prosrc like '%sheet%' as sheets from pg_proc where oid = 'public.ps_create_source_sync(uuid,jsonb,text,text,jsonb)'::regprocedure`
  );
  assert.equal(fn[0].sheets, false);
  await d.close();
});
