import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
const modulesOf = async (user, ws) =>
  (
    await run(
      db,
      user,
      `select industry, modules from erp_my_workspace_modules() where workspace_id = $1`,
      [ws]
    )
  )[0];

before(async () => {
  db = await createDb();
});

test('existing and personal ERPs are General with no modules', async () => {
  const user = await createUser(db, 'ind-general');
  const [{ workspace_id: ws }] = await run(
    db,
    user,
    `select workspace_id from erp_my_workspaces() where is_personal`
  );
  assert.deepEqual(await modulesOf(user, ws), { industry: 'general', modules: [] });
});

test('creating an ERP with an industry switches on its modules', async () => {
  const user = await createUser(db, 'ind-creator');
  const [{ id: quarry }] = await run(
    db,
    user,
    `select erp_create_erp_v2('Batu Jaya', 'quarry') as id`
  );
  assert.deepEqual(await modulesOf(user, quarry), {
    industry: 'quarry',
    modules: ['weighbridge', 'production', 'equipment'],
  });
  const [{ id: factory }] = await run(
    db,
    user,
    `select erp_create_erp_v2('Pabrik', 'manufacturing') as id`
  );
  assert.deepEqual(await modulesOf(user, factory), {
    industry: 'manufacturing',
    modules: ['production', 'equipment'],
  });
  await expectError(run(db, user, `select erp_create_erp_v2('X', 'casino')`), /Unknown industry/);
});

test('Owner and Admin change industry and modules; others cannot; changes are audited', async () => {
  const owner = await createUser(db, 'ind-owner');
  const [{ workspace_id: ws }] = await run(
    db,
    owner,
    `select workspace_id from erp_my_workspaces() where is_personal`
  );
  const join = async (role) => {
    const user = await createUser(db, `ind-${role}`);
    const [{ access_code }] = await run(
      db,
      owner,
      `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`,
      [ws, role]
    );
    await run(db, user, `select erp_redeem_workspace_invitation($1)`, [access_code]);
    return user;
  };
  const adminUser = await join('admin');
  const sales = await join('sales');

  await run(db, owner, `select erp_set_workspace_industry($1, 'trading')`, [ws]);
  assert.deepEqual(await modulesOf(owner, ws), { industry: 'trading', modules: [] });
  await run(
    db,
    adminUser,
    `select erp_set_workspace_industry($1, 'trading', array['weighbridge'])`,
    [ws]
  );
  assert.deepEqual(await modulesOf(sales, ws), { industry: 'trading', modules: ['weighbridge'] });

  await expectError(
    run(db, sales, `select erp_set_workspace_industry($1, 'quarry')`, [ws]),
    /Only the Owner or an Admin/
  );
  await expectError(
    run(db, owner, `select erp_set_workspace_industry($1, 'trading', array['casino'])`, [ws]),
    /Unknown module/
  );

  const audit = await admin(
    db,
    `select details from erp_workspace_audit_log where workspace_id = $1 and action = 'workspace.modules' order by created_at`,
    [ws]
  );
  assert.equal(audit.length, 2);
  assert.deepEqual(audit[1].details.modules, ['weighbridge']);
});

test('module helpers say whether a module is on', async () => {
  const user = await createUser(db, 'ind-helper');
  const [{ id: ws }] = await run(db, user, `select erp_create_erp_v2('Quarry', 'quarry') as id`);
  const [{ on }] = await admin(db, `select erp__module_on($1, 'weighbridge') as on`, [ws]);
  assert.equal(on, true);
  await run(db, user, `select erp_set_workspace_industry($1, 'quarry', array['production'])`, [ws]);
  await expectError(
    admin(db, `select erp__require_module($1, 'weighbridge')`, [ws]),
    /module is switched off/
  );
  await expectError(
    run(db, user, `select erp__module_on($1, 'weighbridge')`, [ws]),
    /permission denied/
  );
});

test('rollback removes industry and modules', async () => {
  const d = await createDb();
  await d.exec(
    readFileSync(
      new URL(
        '../../db/rollback/rollback_20261012000023_erp_industry_modules.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  const { rows } = await d.query(
    `select count(*)::int as n from information_schema.columns where table_name = 'erp_workspaces' and column_name in ('industry', 'modules')`
  );
  assert.equal(rows[0].n, 0);
  await d.close();
});
