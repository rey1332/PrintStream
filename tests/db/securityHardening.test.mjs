import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, runOnPath, admin, expectError } from './harness.mjs';

const CALLABLE = [
  'api_rate_limit_hit', 'erp_accounting_settings_get', 'erp_accounting_settings_set', 'erp_add_exchange_rate',
  'erp_adjust_stock', 'erp_can_read', 'erp_cancel_purchase_order', 'erp_cancel_sales_order', 'erp_check_request',
  'erp_company_profile_get', 'erp_company_profile_set', 'erp_confirm_base_currency','erp_create_gl_account', 'erp_create_invoice_v5', 'erp_create_invoice_v6', 'erp_create_purchase_order_v3',
  'erp_create_erp', 'erp_create_erp_v2', 'erp_create_sales_order_v3', 'erp_create_warehouse',
  'erp_create_workspace_invitation', 'erp_currency_preview', 'erp_currency_settings_get', 'erp_dashboard_metrics', 'erp_decide_po_approval',
  'erp_delete_erp', 'erp_deliver_sales_order', 'erp_empty_erp', 'erp_document_delete', 'erp_document_get', 'erp_document_register',
  'erp_documents_list', 'erp_exchange_rate_lookup', 'erp_has_permission', 'erp_hr_access', 'erp_hr_attendance',
  'erp_hr_attendance_correct', 'erp_hr_clock_in', 'erp_hr_clock_out', 'erp_hr_employee_delete',
  'erp_hr_payroll_preview', 'erp_hr_payroll_reverse', 'erp_hr_payroll_run',
  'erp_hr_holiday_delete', 'erp_hr_holiday_save', 'erp_hr_holidays', 'erp_hr_leave_balances',
  'erp_hr_leave_cancel', 'erp_hr_leave_decide', 'erp_hr_leave_request', 'erp_hr_leaves',
  'erp_hr_pay_item_delete', 'erp_hr_pay_item_save', 'erp_hr_pay_items', 'erp_hr_payroll_runs_v2', 'erp_hr_payslips',
  'erp_hr_set_leave_quota', 'erp_hr_set_work_days', 'erp_hr_work_days_get',
  'erp_hr_employee_save', 'erp_hr_employees', 'erp_hr_set_attendance_roles', 'erp_hr_today',
  'erp_import_exchange_rates', 'erp_issue_invoice_from_sales_order_v2',
  'erp_journal_list', 'erp_list_summary', 'erp_inventory_summary', 'erp_cash_flow_summary', 'erp_list_workspace_audit', 'erp_list_workspace_invitations',
  'erp_list_workspace_member_security', 'erp_list_workspace_members', 'erp_log_access',
  'erp_mfa_clear_recovery_codes', 'erp_mfa_generate_recovery_codes', 'erp_mfa_recovery_status', 'erp_mfa_satisfied',
  'erp_mfa_use_recovery_code', 'erp_my_suspended_workspaces', 'erp_my_workspace_quota', 'erp_my_workspaces', 'erp_ontology_area',
  'erp_ontology_search', 'erp_post_journal', 'erp_read_grants',
  'erp_record_purchase_receipt_v2', 'erp_record_sales_delivery', 'erp_redeem_workspace_invitation',
  'erp_remove_workspace_member', 'erp_rename_workspace', 'erp_reset_workspace', 'erp_reverse_fulfillment_event',
  'erp_reverse_journal', 'erp_revoke_workspace_invitation', 'erp_session_aal', 'erp_set_gl_account_active',
  'erp_set_purchase_tax_rate', 'erp_set_workspace_require_mfa', 'erp_sync_finish', 'erp_sync_inbox_dismiss',
  'erp_sync_inbox_list', 'erp_sync_inbox_post', 'erp_sync_overview', 'erp_sync_set_enabled', 'erp_sync_start',
  'erp_suspended_workspace_ids', 'erp_sync_step', 'erp_transfer_stock', 'erp_trial_balance', 'erp_unit_convert', 'erp_unit_valid', 'erp_party_balances', 'erp_reports_summary', 'erp_my_mfa_required_workspaces', 'erp_my_workspace_modules', 'erp_set_workspace_industry',
  'erp_vehicle_save', 'erp_weigh_in', 'erp_weigh_out', 'erp_weigh_cancel', 'erp_weigh_tickets_invoice', 'erp_weighbridge_summary', 'erp_weigh_customers',
  'erp_production_record', 'erp_production_reverse', 'erp_production_summary',
  'erp_equipment_save', 'erp_equipment_log', 'erp_equipment_log_reverse', 'erp_equipment_overview',
  'erp_hr_payroll_settings_get', 'erp_hr_payroll_settings_set', 'erp_hr_employee_terms', 'erp_hr_employee_terms_save',
  'erp_hr_payroll_preview_v2', 'erp_hr_payroll_run_v2', 'erp_my_announcements',
  'erp_update_purchase_order_status', 'erp_update_sales_order_items', 'erp_update_workspace_member_role',
  'erp_void_invoice', 'erp_void_payment', 'erp_workspace_owner_id', 'erp_workspace_role',
  'erp_workspace_security', 'erp_workspace_settings_get', 'erp_workspace_settings_set','workflow_publish_version', 'workflow_run_cancel', 'workflow_run_cancel_requested',
  'workflow_run_finish', 'workflow_run_start', 'workflow_save_version',
  'erp_create_workspace_invitation_v2', 'erp_update_workspace_member_role_v2', 'erp_list_workspace_members_v2',
  'erp_list_custom_roles', 'erp_save_custom_role', 'erp_delete_custom_role',
  'erp_my_permissions', 'erp_my_workspace_access', 'erp_my_grantable_roles',
  'erp_invite_by_email', 'erp_invitation_mail_result',
  'erp_workspace_retention', 'erp_set_workspace_retention', 'erp_my_termination',
  'erp_log_data_access', 'erp_data_access_log',
  'erp_storage_usage', 'erp_upload_limits', 'erp_reserve_storage', 'erp_release_storage', 'erp_request_storage', 'erp_workspace_storage_dir',
  'ps_enqueue_job', 'ps_cancel_job', 'ps_save_schedule', 'ps_delete_schedule', 'ps_save_trigger', 'ps_delete_trigger',
  'ps_can_access_dataset', 'ps_can_unmask', 'ps_mask_text', 'ps_create_dataset', 'ps_alter_dataset', 'ps_delete_dataset', 'ps_set_item_access',
  'ps_rows_write', 'ps_rows_finish_replace', 'ps_rows_undo_source', 'ps_row_update', 'ps_rows_delete', 'ps_record_lineage',
  'ps_can_see_import', 'ps_create_import', 'ps_reanalyze_import', 'ps_commit_import', 'ps_cancel_import',
  'ps_can_access_pipeline', 'ps_set_pipeline_enabled',
  'erp_my_terminals', 'erp_set_terminal', 'erp_create_terminal', 'ps_my_spaces', 'ps_link_erp', 'ps_unlink_erp',
  'erp_request_company_export', 'erp_company_exports', 'erp_company_export_file',
  'ps_save_connection', 'ps_delete_connection', 'ps_create_sync', 'ps_set_sync', 'ps_delete_sync', 'ps_create_source_sync', 'ps_approve_mcp_tool',
  'ps_save_ai_provider', 'ps_delete_ai_provider', 'ps_set_ai_personal_key', 'ps_has_ai_personal_key', 'ps_set_ai_policy', 'ps_set_ai_settings',
  'ps_ai_budget', 'ps_start_decision', 'ps_finish_decision', 'ps_request_review', 'ps_review_decision', 'ps_set_dataset_entity',
  'erp_tax_faktur_list', 'erp_tax_faktur_export', 'erp_tax_faktur_set', 'erp_supplier_bill_create', 'erp_supplier_bill_pay',
  'erp_supplier_bill_void', 'erp_supplier_bill_bupot', 'erp_invoice_pph23_withheld', 'erp_tax_summary',
  'erp_cash_account_list', 'erp_cash_account_create', 'erp_cash_account_update', 'erp_cash_transfer', 'erp_cash_transfer_list',
  'erp_cash_transfer_void', 'erp_bank_statement_import', 'erp_bank_statement_delete', 'erp_bank_line_candidates',
  'erp_bank_line_match', 'erp_bank_line_unmatch', 'erp_bank_line_ignore', 'erp_bank_line_post', 'erp_bank_auto_match',
  'erp_bank_reconciliation', 'erp_bank_unmatched_ledger', 'erp_fixed_asset_create', 'erp_fixed_asset_void',
  'erp_fixed_assets_depreciate', 'erp_fixed_asset_dispose', 'erp_fixed_asset_schedule',
  'ps_retry_job', 'ps_worker_last_seen', 'ps_mcp_token_create', 'ps_mcp_token_list', 'ps_mcp_token_revoke',
  'ps_oauth_client_get', 'ps_oauth_approve', 'ps_oauth_grant_list', 'ps_oauth_grant_revoke',
].sort();

let db;

const OWN_FUNCTIONS = `
  select p.proname as name, p.oid as oid, format_type(p.prorettype, null) as ret
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`;

before(async () => {
  db = await createDb();
});

test('signed-in users can call exactly the allowlisted functions', async () => {
  const rows = await admin(db, `select distinct name from (${OWN_FUNCTIONS}) f where has_function_privilege('authenticated', f.oid, 'execute') order by 1`);
  assert.deepEqual(rows.map((r) => r.name), CALLABLE);
});

test('anonymous visitors can call only the pre-request check; trigger functions are closed', async () => {
  const anon = await admin(db, `select name from (${OWN_FUNCTIONS}) f where has_function_privilege('anon', f.oid, 'execute')`);
  assert.deepEqual(anon.map((r) => r.name), ['erp_check_request']);
  const triggers = await admin(db, `select name from (${OWN_FUNCTIONS}) f where ret = 'trigger' and has_function_privilege('authenticated', f.oid, 'execute')`);
  assert.deepEqual(triggers, []);
  // The ledger helper that took a caller-built payment row (and leaked exchange rates) is internal.
  const user = await createUser(db, 'fn-probe');
  await expectError(run(db, user, `select * from erp_gl__payment_lines(null::erp_payments, 1)`), /permission denied/);
  await expectError(run(db, user, `select erp_delete_all_data($1)`, [user.id]), /permission denied/);
  await expectError(run(db, user, `select erp_delete_all_transactions($1)`, [user.id]), /permission denied/);
});

test('every SECURITY DEFINER function has a fixed search_path', async () => {
  const rows = await admin(db, `select n.nspname || '.' || p.proname as name
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
    order by 1`);
  assert.deepEqual(rows.map((r) => r.name), []);
});

test('functions created later are not callable until a migration grants them', async () => {
  const d = await createDb();
  await d.exec(`create function public.test_new_helper() returns int language sql as 'select 1'`);
  const [{ auth, pub }] = (await d.query(`select has_function_privilege('authenticated', 'public.test_new_helper()', 'execute') as auth,
    has_function_privilege('anon', 'public.test_new_helper()', 'execute') as pub`)).rows;
  assert.equal(auth, false);
  assert.equal(pub, false);
  await d.close();
});

async function seed(user) {
  await run(db, user, `insert into erp_customers (user_id, name) values ($1, 'Cust')`, [user.id]);
  await run(db, user, `select erp_create_invoice_v5(null, null, 'Walk-in', current_date, current_date + 7, 50, 0, null, null)`);
}

const count = async (table, user) =>
  (await admin(db, `select count(*)::int as n from ${table} where user_id = $1`, [user.id]))[0].n;

test('reset: only from the server route, only by the Owner, only this ERP; the audit log stays', async () => {
  const owner = await createUser(db, 'reset-owner');
  const bystander = await createUser(db, 'reset-bystander');
  await seed(owner);
  await seed(bystander);
  const [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'admin', 24, '')`, [ws]);
  const adminUser = await createUser(db, 'reset-admin');
  await run(db, adminUser, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  const auditBefore = await count('erp_audit_log', owner);
  assert.ok(auditBefore > 0);

  // Not through /api/data (whose path is /rpc/<function>), and not by an admin.
  await expectError(run(db, owner, `select erp_reset_workspace($1, 'all')`, [ws]), /reset from Settings/);
  await expectError(runOnPath(db, owner, '/rpc/erp_reset_workspace', `select erp_reset_workspace($1, 'all')`, [ws]), /reset from Settings/);
  await expectError(runOnPath(db, adminUser, '/account/reset', `select erp_reset_workspace($1, 'all')`, [ws]), /Only the owner/);
  await expectError(runOnPath(db, owner, '/account/reset', `select erp_reset_workspace($1, 'everything')`, [ws]), /Unknown reset/);

  const [{ removed }] = await runOnPath(db, owner, '/account/reset', `select erp_reset_workspace($1, 'transactions') as removed`, [ws]);
  assert.equal(removed.invoices, 1);
  assert.equal(await count('erp_invoices', owner), 0);
  assert.equal(await count('erp_customers', owner), 1, 'master data stays on a transactions reset');

  await runOnPath(db, owner, '/account/reset', `select erp_reset_workspace($1, 'all')`, [ws]);
  assert.equal(await count('erp_customers', owner), 0);
  assert.ok(await count('erp_audit_log', owner) >= auditBefore, 'the audit log is kept');
  const trail = await admin(db, `select details from erp_workspace_audit_log where workspace_id = $1 and action = 'workspace.reset' order by created_at`, [ws]);
  assert.deepEqual(trail.map((r) => r.details.scope), ['transactions', 'all']);

  assert.equal(await count('erp_invoices', bystander), 1, 'other ERPs are untouched');
  assert.equal(await count('erp_customers', bystander), 1);
});

test('a reset needs a verified session when the account has two-factor', async () => {
  const user = await createUser(db, 'reset-2fa');
  await db.query(`insert into auth.mfa_factors (user_id, friendly_name, status) values ($1, 'phone', 'verified')`, [user.id]);
  await expectError(runOnPath(db, { ...user, aal: 'aal1' }, '/account/reset', `select erp_reset_workspace(null, 'transactions')`), /not allowed|Only the owner|Two-factor/i);
  const [{ removed }] = await runOnPath(db, { ...user, aal: 'aal2' }, '/account/reset', `select erp_reset_workspace(null, 'transactions') as removed`);
  assert.equal(removed.invoices, 0);
});

test('rollback restores the previous grants', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261011000000_erp_security_hardening.sql', import.meta.url), 'utf8'));
  const [{ ok, gone }] = (await d.query(`select has_function_privilege('authenticated', 'public.erp_delete_all_data(uuid)', 'execute') as ok,
    to_regprocedure('public.erp_reset_workspace(uuid,text)') is null as gone`)).rows;
  assert.equal(ok, true);
  assert.equal(gone, true);
  await d.close();
});
