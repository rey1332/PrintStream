-- Superseded function versions are no longer callable by signed-in users.
--
-- Each time a document function gained a parameter (workspace, tax, currency,
-- rate, lines) a new version was added and the old one stayed callable, so
-- that an app still running the previous release kept working during an
-- update. The app now calls only the current versions:
--   invoices          erp_create_invoice_v6 (lines) / _v5
--   purchase orders   erp_create_purchase_order_v3, erp_record_purchase_receipt_v2
--   sales orders      erp_create_sales_order_v3, erp_issue_invoice_from_sales_order_v2
--   payroll           erp_hr_payroll_runs_v2
-- The older versions below stay in the database (newer versions are built on
-- some of them) but nobody can call them directly any more: less to secure,
-- fewer ways to create a document that skips a newer rule.
--
-- Rollback: db/rollback/rollback_20261012000019_erp_retire_old_function_versions.sql

REVOKE EXECUTE ON FUNCTION public.erp_create_invoice(UUID, TEXT, DATE, DATE, NUMERIC) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.erp_create_invoice_v2(UUID, UUID, TEXT, DATE, DATE, NUMERIC) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.erp_create_invoice_v3(UUID, UUID, TEXT, DATE, DATE, NUMERIC, NUMERIC) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.erp_create_invoice_v4(UUID, UUID, TEXT, DATE, DATE, NUMERIC, NUMERIC, TEXT, NUMERIC) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.erp_create_purchase_order(UUID, TEXT, DATE, TEXT, JSONB) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.erp_create_purchase_order_v2(UUID, UUID, TEXT, DATE, TEXT, JSONB) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.erp_create_sales_order(UUID, TEXT, DATE, TEXT, JSONB) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.erp_create_sales_order_v2(UUID, UUID, TEXT, DATE, TEXT, JSONB) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.erp_issue_invoice_from_sales_order(UUID, DATE) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.erp_record_purchase_receipt(UUID, JSONB, UUID, TEXT) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.erp_hr_payroll_runs(UUID) FROM authenticated;
