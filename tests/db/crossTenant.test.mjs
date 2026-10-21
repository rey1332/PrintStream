import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, run, admin, items } from './harness.mjs';

// A Monday and Tuesday two weeks ahead: a fixed offset from today could land on a weekend.
const NEXT_WORKDAYS = `(date_trunc('week', current_date) + interval '14 days')::date, (date_trunc('week', current_date) + interval '15 days')::date`;

const MARK = 'VICTIMSECRET';
let db;
let victim;
let outsider;
const ids = {};

const one = async (user, sql, params = []) => {
  const [row] = await run(db, user, sql, params);
  return row ? Object.values(row)[0] : null;
};

before(async () => {
  db = await createDb();
  victim = await createUser(db, 'victim');
  outsider = await createUser(db, 'outsider');
  const V = victim;
  ids.ws = (await run(db, V, `select workspace_id from erp_my_workspaces()`))[0].workspace_id;
  ids.outsiderWs = (await run(db, outsider, `select workspace_id from erp_my_workspaces()`))[0].workspace_id;
  ids.branch = await one(V, `select erp_create_erp('${MARK} branch')`);
  ids.container = (await admin(db, `select owner_id from erp_workspaces where id = $1`, [ids.branch]))[0].owner_id;
  const ws = ids.ws;

  await run(db, V, `select erp_company_profile_set($1, $2::jsonb)`, [ws, JSON.stringify({ name: `${MARK} Co`, address: MARK })]);
  ids.customer = await one(V, `insert into erp_customers (user_id, name) values ($1, '${MARK} customer') returning id`, [V.id]);
  ids.supplier = await one(V, `insert into erp_suppliers (user_id, name) values ($1, '${MARK} supplier') returning id`, [V.id]);
  ids.product = await one(V, `insert into erp_products (user_id, name, current_stock, purchase_price, selling_price) values ($1, '${MARK} product', 100, 10, 20) returning id`, [V.id]);
  ids.so = await one(V, `select erp_create_sales_order_v3(null, null, '${MARK}', current_date, '${MARK}', $1::jsonb, null, null)`, [items([ids.product, 5, 30])]);
  ids.so2 = await one(V, `select erp_create_sales_order_v3(null, null, '${MARK}', current_date, '${MARK}', $1::jsonb, null, null)`, [items([ids.product, 2, 30])]);
  ids.invoice = await one(V, `select erp_issue_invoice_from_sales_order_v2($1, null, null)`, [ids.so]);
  ids.soLine = (await admin(db, `select id from erp_sales_order_items where sales_order_id = $1`, [ids.so]))[0].id;
  ids.delivery = await one(V, `select erp_record_sales_delivery($1, $2::jsonb, $3)`, [ids.so, JSON.stringify([{ item_id: ids.soLine, qty: 1 }]), randomUUID()]);
  ids.payment = await one(V, `insert into erp_payments (user_id, payment_type, party, amount, invoice_id) values ($1, 'incoming', '${MARK}', 10, $2) returning id`, [V.id, ids.invoice]);
  ids.po = await one(V, `select erp_create_purchase_order_v3(null, null, '${MARK}', current_date, '${MARK}', $1::jsonb, null, null)`, [items([ids.product, 3, 10])]);
  await run(db, V, `select erp_update_purchase_order_status($1, 'approved')`, [ids.po]);
  ids.po2 = await one(V, `select erp_create_purchase_order_v3(null, null, '${MARK}', current_date, '${MARK}', $1::jsonb, null, null)`, [items([ids.product, 3, 10])]);
  ids.poLine = (await admin(db, `select id from erp_purchase_order_items where purchase_order_id = $1`, [ids.po]))[0].id;
  ids.receipt = await one(V, `select erp_record_purchase_receipt_v2($1, $2::jsonb, $3, '', null)`, [ids.po, JSON.stringify([{ item_id: ids.poLine, qty: 1 }]), randomUUID()]);
  ids.cash = (await admin(db, `select id from erp_gl_accounts where user_id = $1 and system_key = 'cash'`, [V.id]))[0].id;
  ids.otherAccount = (await admin(db, `select id from erp_gl_accounts where user_id = $1 and system_key <> 'cash' limit 1`, [V.id]))[0].id;
  ids.journal = await one(V, `select erp_post_journal(null, current_date, '${MARK} memo', $1::jsonb)`, [
    JSON.stringify([{ account_id: ids.cash, debit: 5, credit: 0 }, { account_id: ids.otherAccount, debit: 0, credit: 5 }]),
  ]);
  ids.warehouse = await one(V, `select erp_create_warehouse(null, 'W2', '${MARK} warehouse')`);
  ids.mainWarehouse = (await admin(db, `select id from erp_warehouses where user_id = $1 and id <> $2 limit 1`, [V.id, ids.warehouse]))[0].id;
  ids.employee = await one(V, `select erp_hr_employee_save($1, null, $2::jsonb)`, [ws, JSON.stringify({ name: `${MARK} employee`, hourly_rate: 50000 })]);
  ids.attendance = await one(V, `select erp_hr_clock_in($1, $2, 'Asia/Jakarta', '')`, [ws, ids.employee]);
  await admin(db, `update erp_attendance set clock_in = now() - interval '9 hours', work_date = current_date - 1 where id = $1`, [ids.attendance]);
  await run(db, V, `select erp_hr_clock_out($1, $2, '')`, [ws, ids.employee]);
  ids.holiday = await one(V, `select erp_hr_holiday_save($1, current_date + 30, '${MARK}', true)`, [ws]);
  ids.leave = await one(V, `select erp_hr_leave_request($1, $2, 'annual', ${NEXT_WORKDAYS}, '${MARK}')`, [ws, ids.employee]);
  ids.payItem = await one(V, `select erp_hr_pay_item_save($1, $2, null, $3::jsonb)`, [ws, ids.employee, JSON.stringify({ kind: 'allowance', name: MARK, method: 'fixed', amount: 1000 })]);
  ids.payroll = await one(V, `select erp_hr_payroll_run($1, current_date - 5, current_date - 1, current_date, 'cash')`, [ws]);
  ids.invitation = (await run(db, V, `select * from erp_create_workspace_invitation($1, 'admin', 24, '${MARK}')`, [ws]))[0].invitation_id;
  await run(db, V, `select set_config('request.path', '/documents/upload', true), erp_document_register($1, '${MARK}.pdf', 'application/pdf', 10, $2)`, [ws, 'a'.repeat(64)]);
  ids.document = (await admin(db, `select id from erp_documents where workspace_id = $1`, [ws]))[0].id;
  ids.workflow = await one(V, `insert into workflows (user_id, name, graph) values ($1, '${MARK}', '{"nodes":[],"edges":[]}') returning id`, [V.id]);
  ids.workflowVersion = (await run(db, V, `select * from workflow_save_version($1, '${MARK}', true)`, [ids.workflow]))[0].id;
  ids.workflowRun = (await run(db, V, `select * from workflow_run_start($1, 'draft', null, $2, 'h', 'manual')`, [ids.workflow, randomUUID()]))[0].run_id;
  await run(db, V, `select erp_sync_set_enabled($1, true)`, [ws]);
  await run(db, V, `select erp_sync_set_enabled($1, true)`, [ids.branch]);
  ids.syncRun = await one(V, `select erp_sync_start($1, array[$2]::uuid[], 'push', array['customers'], null)`, [ws, ids.branch]);
  for (const [key, value] of Object.entries(ids)) assert.ok(value, `seeded ${key}`);
});

async function fingerprint(q, tables) {
  const workspaces = [ids.ws, ids.branch];
  const users = [victim.id, ids.container];
  const out = {};
  for (const t of tables) {
    const [where, param] =
      t.relname === 'erp_workspaces' ? ['id = any($1::uuid[])', workspaces]
      : t.relname === 'user_profiles' ? ['id = any($1::uuid[])', users]
      : t.ws ? ['workspace_id = any($1::uuid[])', workspaces]
      : t.uid ? ['user_id = any($1::uuid[])', users]
      : t.oid ? ['owner_id = any($1::uuid[])', users]
      : ['true', null];
    const sql = `select md5(coalesce(string_agg(md5(r::text), ',' order by md5(r::text)), '')) h from public.${t.relname} r where ${where}`;
    out[t.relname] = (await q(sql, param ? [param] : []))[0].h;
  }
  out['auth.users'] = (await q(`select md5(coalesce(string_agg(md5(u::text), ',' order by u.id), '')) h from auth.users u where id = any($1::uuid[])`, [users]))[0].h;
  return out;
}

function argFor(fn, name, type, variant) {
  if (type === 'uuid') {
    if (name === 'p_item_id') return fn.startsWith('erp_sync') ? randomUUID() : ids.payItem;
    if (name === 'p_run_id') return fn.startsWith('erp_sync') ? ids.syncRun : fn.startsWith('workflow') ? ids.workflowRun : ids.payroll;
    const byName = {
      p_workspace_id: variant ? ids.branch : ids.ws, p_source: variant ? ids.outsiderWs : ids.ws, p_target: variant ? ids.ws : ids.branch,
      p_customer_id: ids.customer, p_supplier_id: ids.supplier, p_product_id: ids.product,
      p_sales_order_id: variant ? ids.so2 : ids.so, p_purchase_order_id: variant ? ids.po2 : ids.po,
      p_invoice_id: ids.invoice, p_payment_id: ids.payment, p_employee_id: ids.employee, p_attendance_id: ids.attendance,
      p_holiday_id: ids.holiday, p_leave_id: ids.leave, p_event_id: variant ? ids.receipt : ids.delivery,
      p_entry_id: ids.journal, p_account_id: ids.cash, p_document_id: ids.document, p_invitation_id: ids.invitation,
      p_workflow_id: ids.workflow, p_version_id: ids.workflowVersion, p_user_id: victim.id,
      p_from_warehouse: ids.mainWarehouse, p_to_warehouse: ids.warehouse, p_object_id: ids.customer,
      p_request_id: randomUUID(), p_id_from: null, p_id_to: null,
    };
    return name in byName ? byName[name] : ids.ws;
  }
  if (type === 'uuid[]') return variant ? [ids.ws] : [ids.branch];
  if (type === 'text') {
    if (name === 'p_type') return fn.includes('gl_account') ? 'asset' : fn.includes('leave') ? 'annual' : 'customers';
    if (name === 'p_status') return fn.includes('workflow') ? 'succeeded' : fn.includes('purchase') ? 'approved' : 'cancelled';
    const byName = {
      p_decision: 'approved', p_role: 'admin', p_scope: 'all', p_currency: 'USD', p_base_currency: 'USD',
      p_from: 'USD', p_to: 'IDR', p_tz: 'Asia/Jakarta', p_permission: 'read', p_area: 'customers', p_kind: 'customers',
      p_action: 'view', p_direction: variant ? 'pull' : 'push', p_entity: 'customers', p_provider: 'manual',
      p_credit_to: 'cash', p_run_kind: 'draft', p_triggered_by: 'manual', p_content_type: 'application/pdf',
      p_file_name: 'a.pdf', p_sha256: 'b'.repeat(64), p_code: 'ETNA-AAAAA-AAAAA-AAAAA-AAAAA',
    };
    return name in byName ? byName[name] : 'probe text';
  }
  if (type === 'text[]') return name === 'p_roles' ? ['sales'] : name === 'p_patterns' ? ['%'] : name === 'p_statuses' ? null : ['customers'];
  if (type === 'jsonb') {
    if (name === 'p_items') return items([ids.product, 1, 1]);
    if (name === 'p_lines') {
      if (fn.includes('journal')) return JSON.stringify([{ account_id: ids.cash, debit: 1, credit: 0 }, { account_id: ids.otherAccount, debit: 0, credit: 1 }]);
      return JSON.stringify([{ item_id: fn.includes('purchase') ? ids.poLine : ids.soLine, qty: 1 }]);
    }
    if (name === 'p_data') return JSON.stringify(fn.includes('pay_item') ? { kind: 'allowance', name: 'x', method: 'fixed', amount: 1 } : { name: 'x', hourly_rate: 1 });
    if (name === 'p_rows') return '[]';
    return name === 'p_profile' ? JSON.stringify({ name: 'x' }) : '{}';
  }
  if (type === 'integer[]') return [1, 2, 3, 4, 5];
  if (['integer', 'bigint', 'numeric'].includes(type)) {
    const byName = { p_year: new Date().getFullYear(), p_days: 12, p_limit: 50, p_offset: 0, p_expires_in_hours: 24, p_size_bytes: 10, p_rate: 2, p_fx_rate: null, p_sales_tax_rate: 11, p_tax_rate: 11 };
    return name in byName ? byName[name] : 1;
  }
  if (type === 'date') return name === 'p_from' || name === 'p_date_from' ? '2000-01-01' : name === 'p_to' || name === 'p_date_to' ? '2100-01-01' : new Date().toISOString().slice(0, 10);
  if (type === 'timestamp with time zone') return new Date().toISOString();
  if (type === 'boolean') return name !== 'p_enabled';
  if (type === 'stock_movement_type') return 'out';
  return null;
}

const ROUTE_PATHS = {
  erp_delete_erp: '/account/delete-erp',
  erp_empty_erp: '/account/delete-erp',
  erp_reset_workspace: '/account/reset',
  erp_document_register: '/documents/upload',
  erp_document_delete: '/documents/delete',
  erp_import_exchange_rates: '/currency/import',
};

async function probe() {
  const tables = await admin(db, `select c.relname,
      exists (select 1 from information_schema.columns x where x.table_schema = 'public' and x.table_name = c.relname and x.column_name = 'workspace_id') ws,
      exists (select 1 from information_schema.columns x where x.table_schema = 'public' and x.table_name = c.relname and x.column_name = 'user_id') uid,
      exists (select 1 from information_schema.columns x where x.table_schema = 'public' and x.table_name = c.relname and x.column_name = 'owner_id') oid
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname not in ('api_rate_limits', 'erp_access_log', 'erp_invitation_attempts')`);
  const fns = await admin(db, `select p.proname as name, array(select format_type(t, null) from unnest(p.proargtypes) t) as types, p.proargnames as names
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'execute')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`);
  const victimIds = [victim.id, victim.email, MARK, ...Object.entries(ids).filter(([k]) => k !== 'outsiderWs').map(([, v]) => v)];
  const problems = [];

  for (const fn of fns) {
    for (const variant of [0, 1]) {
      const params = fn.types.map((type, i) => argFor(fn.name, fn.names[i], type, variant));
      const sql = `select * from public.${fn.name}(${fn.types.map((t, i) => `$${i + 1}::${t}`).join(', ')})`;
      await db
        .transaction(async (tx) => {
          const q = async (s, p = []) => (await tx.query(s, p)).rows;
          const before = await fingerprint(q, tables);
          await tx.exec('set local role authenticated');
          const claims = { sub: outsider.id, email: outsider.email, role: 'authenticated', aal: 'aal2' };
          await q(`select set_config('request.jwt.claims', $1, true), set_config('request.path', $2, true)`, [
            JSON.stringify(claims),
            ROUTE_PATHS[fn.name] ?? `/rpc/${fn.name}`,
          ]);
          let rows;
          try {
            rows = await q(sql, params);
          } catch {
            throw new Error('rollback'); // refused: fine
          }
          await tx.exec('reset role');
          const after = await fingerprint(q, tables);
          const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
          const text = JSON.stringify(rows);
          const leaked = victimIds.filter((v) => text.includes(v));
          if (changed.length || leaked.length)
            problems.push(`${fn.name} (variant ${variant}): changed [${changed}] returned [${leaked}]`);
          throw new Error('rollback');
        })
        .catch((error) => {
          if (error.message !== 'rollback') throw error;
        });
    }
  }
  return { problems, functions: fns.length };
}

test('an outsider cannot change or read another ERP through any callable function', async () => {
  const { problems, functions } = await probe();
  assert.ok(functions > 100);
  assert.deepEqual(problems, []);
});

test('the probe notices a function that forgets its membership check', async () => {
  await db.exec(`
    create function public.test_forgot_check(p_workspace_id uuid) returns setof text
      language sql security definer set search_path = public
      as 'select name from erp_customers where workspace_id = p_workspace_id';
    grant execute on function public.test_forgot_check(uuid) to authenticated;`);
  try {
    const { problems } = await probe();
    assert.ok(problems.some((p) => p.startsWith('test_forgot_check (variant 0)')), problems.join('\n'));
  } finally {
    await db.exec('drop function public.test_forgot_check(uuid)');
  }
});
