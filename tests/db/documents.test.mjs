import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser, run, admin, expectError } from './harness.mjs';
import { MAX_DOCUMENT_BYTES, MAX_WORKSPACE_DOCUMENT_BYTES } from '../../src/lib/workspaces/limits.ts';

let db;
let owner;
let sales;
let finance;
let outsider;
let ws;

const SHA = 'a'.repeat(64);

async function asRoute(user, path, sql, params = []) {
  return asUser(db, user, async (q) => {
    await q(`select set_config('request.path', $1, true)`, [path]);
    return q(sql, params);
  });
}

async function upload(user, name = 'invoice.pdf', size = 1000, workspace = ws) {
  const [{ id }] = await asRoute(
    user, '/documents/upload',
    `select erp_document_register($1, $2, 'application/pdf', $3, $4) as id`, [workspace, name, size, SHA]
  );
  return id;
}

async function join(role) {
  const member = await createUser(db, `doc-${role}`);
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`, [ws, role]);
  await run(db, member, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  return member;
}

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'doc-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
  sales = await join('sales');
  finance = await join('finance');
  outsider = await createUser(db, 'doc-outsider');
});

test('the app and the database agree on the size limits', async () => {
  const [{ def }] = await admin(db, `select pg_get_constraintdef(c.oid) as def from pg_constraint c
    where c.conrelid = 'public.erp_documents'::regclass and pg_get_constraintdef(c.oid) like '%size_bytes <=%'`);
  assert.match(def, new RegExp(`size_bytes <= ${MAX_DOCUMENT_BYTES}`));
  const [{ src }] = await admin(db, `select prosrc as src from pg_proc where proname = 'erp_document_register'`);
  assert.ok(src.includes(String(MAX_WORKSPACE_DOCUMENT_BYTES)));
});

test('members upload and list; outsiders see nothing', async () => {
  const id = await upload(sales, 'quote.pdf');
  const listed = await run(db, finance, `select id, file_name, uploaded_by_email, can_delete from erp_documents_list($1)`, [ws]);
  const row = listed.find((r) => r.id === id);
  assert.equal(row.file_name, 'quote.pdf');
  assert.equal(row.uploaded_by_email, sales.email);
  assert.equal(row.can_delete, false, 'finance did not upload it and does not manage members');

  await expectError(run(db, outsider, `select * from erp_documents_list($1)`, [ws]), /not allowed/);
  await expectError(run(db, outsider, `select * from erp_document_get($1)`, [id]), /not found/);
  await expectError(upload(outsider, 'x.pdf'), /not allowed/);

  // No direct table access for anyone.
  await expectError(run(db, owner, `select * from erp_documents`), /permission denied/);
  await expectError(run(db, owner, `insert into erp_documents (workspace_id, file_name, content_type, size_bytes, sha256) values ($1, 'a', 'b', 1, $2)`, [ws, SHA]), /permission denied/);

  const [doc] = await run(db, finance, `select * from erp_document_get($1)`, [id]);
  assert.equal(doc.workspace_id, ws);
  assert.equal(doc.sha256, SHA);
});

test('register and delete only through the server routes (request.path)', async () => {
  await expectError(
    run(db, owner, `select erp_document_register($1, 'a.pdf', 'application/pdf', 10, $2)`, [ws, SHA]),
    /uploaded through the documents page/
  );
  await expectError(
    asRoute(owner, '/rpc/erp_document_register', `select erp_document_register($1, 'a.pdf', 'application/pdf', 10, $2)`, [ws, SHA]),
    /uploaded through the documents page/
  );
  const id = await upload(owner, 'keep.pdf');
  await expectError(run(db, owner, `select erp_document_delete($1)`, [id]), /deleted through the documents page/);
});

test('the uploader, owners and admins delete; others cannot', async () => {
  const mine = await upload(sales, 'mine.pdf');
  const theirs = await upload(owner, 'owner.pdf');

  await expectError(asRoute(sales, '/documents/delete', `select erp_document_delete($1)`, [theirs]), /Only the uploader/);
  await expectError(asRoute(outsider, '/documents/delete', `select erp_document_delete($1)`, [mine]), /not found/);

  const [{ w }] = await asRoute(sales, '/documents/delete', `select erp_document_delete($1) as w`, [mine]);
  assert.equal(w, ws);
  await asRoute(owner, '/documents/delete', `select erp_document_delete($1)`, [theirs]);

  const left = await admin(db, `select id from erp_documents where id = any($1::uuid[])`, [[mine, theirs]]);
  assert.equal(left.length, 0);
  const audit = await admin(db, `select action from erp_workspace_audit_log where workspace_id = $1 and action like 'document.%'`, [ws]);
  assert.ok(audit.some((a) => a.action === 'document.uploaded'));
  assert.ok(audit.some((a) => a.action === 'document.deleted'));
});

test('a workspace that requires two-factor needs a verified session', async () => {
  await admin(db, `update erp_workspaces set require_mfa = true where id = $1`, [ws]);
  try {
    await expectError(run(db, { ...finance, aal: 'aal1' }, `select * from erp_documents_list($1)`, [ws]), /not allowed/);
    const rows = await run(db, { ...finance, aal: 'aal2' }, `select count(*)::int as n from erp_documents_list($1)`, [ws]);
    assert.ok(rows[0].n >= 0);
  } finally {
    await admin(db, `update erp_workspaces set require_mfa = false where id = $1`, [ws]);
  }
});

test('size limits: per file and per workspace', async () => {
  await expectError(upload(owner, 'big.pdf', MAX_DOCUMENT_BYTES + 1), /size_bytes|check constraint/);
  const other = await createUser(db, 'doc-full');
  const [{ workspace_id: full }] = await run(db, other, `select workspace_id from erp_my_workspaces()`);
  await admin(
    db,
    `insert into erp_documents (workspace_id, uploaded_by, file_name, content_type, size_bytes, sha256)
     select $1, $2, 'f' || g, 'application/pdf', $3, $4 from generate_series(1, 102) g`,
    [full, other.id, MAX_DOCUMENT_BYTES, SHA]
  );
  await expectError(upload(other, 'one-more.pdf', MAX_DOCUMENT_BYTES, full), /no room/);
});
